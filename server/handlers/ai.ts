import { randomUUID } from 'crypto';
import {
  addAiProvider,
  deleteAiProvider,
  findAiProvider,
  loadAiProviders,
  updateAiProvider,
} from '../aiProviders';
import { adapterFor } from '../ai/adapters';
import { HistoryEntry, runAgent } from '../ai/agent';
import { findDefinition, isProviderKind, PROVIDER_DEFINITIONS } from '../ai/catalog';
import { AiRequestError, resolveBaseUrl } from '../ai/net';
import { createSchemaToolset } from '../ai/tools';
import { AiChatEvent, AiStreamEvent } from '../channels';
import { findConnection } from '../connections';
import { AppError, registerHandler } from '../dispatch';
import { redactSecrets } from '../redact';
import { activeConnections } from './connections';

/** Keeps a runaway client from stuffing the model's context through the chat channel. */
const MAX_QUESTION_LENGTH = 4000;
const MAX_HISTORY_ENTRIES = 40;

/**
 * Where a running answer's events go.
 *
 * The HTTP version wrote NDJSON lines straight to the response socket. There is no response
 * to write to now, so events are pushed instead — `electron/ipc.ts` points this at the
 * window's webContents, and a test can point it at an array.
 */
type AiEmitter = (payload: AiChatEvent) => void;

let emit: AiEmitter = () => {};

export function setAiStreamEmitter(emitter: AiEmitter): void {
  emit = emitter;
}

/** streamId → the controller that aborts that answer's provider call. */
const runningStreams = new Map<string, AbortController>();

/** Aborts every in-flight answer. Called when the window goes away and on quit. */
export function cancelAllAiStreams(): void {
  for (const controller of runningStreams.values()) controller.abort();
  runningStreams.clear();
}

function cleanModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) seen.add(entry.trim());
  }
  return [...seen];
}

function parseHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e): e is HistoryEntry => {
      const entry = e as Partial<HistoryEntry>;
      return (
        (entry?.role === 'user' || entry?.role === 'assistant') && typeof entry.text === 'string'
      );
    })
    .slice(-MAX_HISTORY_ENTRIES)
    .map((e) => ({
      role: e.role,
      text: e.text,
      sql: typeof e.sql === 'string' ? e.sql : null,
    }));
}

function providerMessage(err: unknown): string {
  return err instanceof AiRequestError
    ? err.message
    : redactSecrets(err instanceof Error ? err.message : String(err));
}

export function registerAiHandlers(): void {
  // The provider catalog plus whatever the user has configured. Never carries an API key —
  // same rule as connections, where the password stays in the main process.
  registerHandler('ai:providers:list', () => ({
    catalog: PROVIDER_DEFINITIONS,
    providers: loadAiProviders(),
  }));

  registerHandler(
    'ai:providers:add',
    async (body: {
      provider?: string;
      label?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: unknown;
    }) => {
      const { provider, label, baseUrl, apiKey, models } = body ?? {};

      if (!isProviderKind(provider)) throw new AppError(400, 'Unknown provider type.');
      const definition = findDefinition(provider)!;
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        throw new AppError(400, 'An API key is required.');
      }

      let resolvedBaseUrl: string | undefined;
      if (definition.requiresBaseUrl) {
        try {
          resolvedBaseUrl = resolveBaseUrl(baseUrl ?? '');
        } catch (err) {
          throw new AppError(400, err instanceof Error ? err.message : 'Invalid base URL.');
        }
      }

      return addAiProvider({
        provider,
        label: (typeof label === 'string' && label.trim()) || definition.label,
        baseUrl: resolvedBaseUrl,
        apiKey: apiKey.trim(),
        models: cleanModels(models),
      });
    },
  );

  /**
   * Asks a provider which models the key can use.
   *
   * Serves both callers: the add form passes an unsaved `provider` + `apiKey`, an existing
   * card passes `id` and the stored key is used. Listing is best-effort by nature — Azure
   * data-plane keys usually cannot enumerate deployments and a homemade OpenAI-compatible
   * server may not implement /models — so a failure is a 400 the UI shows next to the
   * "type a model id" field rather than something that blocks configuration.
   */
  registerHandler(
    'ai:providers:models',
    async (body: { id?: string; provider?: string; baseUrl?: string; apiKey?: string }) => {
      const { id, provider, baseUrl, apiKey } = body ?? {};

      const stored = typeof id === 'string' ? findAiProvider(id) : undefined;
      if (typeof id === 'string' && !stored) throw new AppError(404, 'Provider not found');

      const kind = stored?.provider ?? provider;
      if (!isProviderKind(kind)) throw new AppError(400, 'Unknown provider type.');

      // A key typed into the form wins, so the user can re-list after pasting a new one.
      const key = (typeof apiKey === 'string' && apiKey.trim()) || stored?.apiKey || '';
      if (!key) throw new AppError(400, 'Enter the API key first.');

      let resolvedBaseUrl: string | undefined;
      if (findDefinition(kind)!.requiresBaseUrl) {
        try {
          resolvedBaseUrl = resolveBaseUrl(
            (typeof baseUrl === 'string' && baseUrl.trim()) || stored?.baseUrl || '',
          );
        } catch (err) {
          throw new AppError(400, err instanceof Error ? err.message : 'Invalid base URL.');
        }
      }

      try {
        const models = await adapterFor(kind).listModels({ apiKey: key, baseUrl: resolvedBaseUrl });
        // Providers return these in wildly different orders; sorted is easier to scan.
        return { models: [...new Set(models)].sort() };
      } catch (err) {
        throw new AppError(400, providerMessage(err));
      }
    },
  );

  registerHandler(
    'ai:providers:update',
    async (body: {
      id: string;
      label?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: unknown;
    }) => {
      const { id, label, baseUrl, apiKey, models } = body ?? {};
      if (!findAiProvider(id)) throw new AppError(404, 'Provider not found');

      let resolvedBaseUrl: string | undefined;
      if (typeof baseUrl === 'string' && baseUrl.trim()) {
        try {
          resolvedBaseUrl = resolveBaseUrl(baseUrl);
        } catch (err) {
          throw new AppError(400, err instanceof Error ? err.message : 'Invalid base URL.');
        }
      }

      return updateAiProvider(id, {
        ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
        ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
        // A blank key means "keep the stored one", like the connection dialog's password box.
        ...(typeof apiKey === 'string' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(models !== undefined ? { models: cleanModels(models) } : {}),
      });
    },
  );

  registerHandler('ai:providers:delete', async ({ id }: { id: string }) => {
    const removed = await deleteAiProvider(id);
    if (!removed) throw new AppError(404, 'Provider not found');
    return { ok: true };
  });

  /**
   * Starts one question and returns immediately with a stream id.
   *
   * Everything that can be checked up front still fails up front — the panel gets a plain
   * rejection for a missing model or an unconfigured provider, exactly as it did when this
   * was an HTTP 400 before the first byte. Once the agent is running, failures can only be
   * reported as a final `error` event, because the answer has already started arriving.
   */
  registerHandler(
    'ai:chat:start',
    async (body: {
      providerId?: string;
      model?: string;
      connectionId?: string;
      database?: string;
      question?: string;
      history?: unknown;
    }) => {
      const { providerId, model, connectionId, database, question, history } = body ?? {};

      if (typeof question !== 'string' || !question.trim()) {
        throw new AppError(400, 'A question is required.');
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        throw new AppError(400, 'That question is too long.');
      }
      if (typeof model !== 'string' || !model.trim()) {
        throw new AppError(400, 'Pick a model first.');
      }

      const provider = typeof providerId === 'string' ? findAiProvider(providerId) : undefined;
      if (!provider) throw new AppError(404, 'That AI provider is no longer configured.');

      if (!connectionId || !database) {
        throw new AppError(400, 'connectionId and database are required.');
      }
      const connection = findConnection(connectionId);
      const driver = activeConnections.get(`${connectionId}::${database}`);
      if (!connection || !driver) {
        throw new AppError(
          404,
          'No active connection for this database. Open it from the explorer first.',
        );
      }

      const streamId = randomUUID();
      const controller = new AbortController();
      runningStreams.set(streamId, controller);

      const send = (event: AiStreamEvent) => {
        // A cancelled stream has already been forgotten; nothing should still be arriving
        // for it, and the panel has stopped listening either way.
        if (runningStreams.has(streamId)) emit({ streamId, event });
      };

      // Deliberately not awaited: the whole point is that the handler returns the id now and
      // the answer arrives as events. Errors are caught inside.
      void (async () => {
        try {
          const result = await runAgent({
            adapter: adapterFor(provider.provider),
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: model.trim(),
            dbType: connection.type,
            database,
            toolset: createSchemaToolset(driver, connection.type, database),
            history: parseHistory(history),
            question: question.trim(),
            signal: controller.signal,
            onStep: (step) => send({ type: 'step', label: step.label }),
          });
          send({ type: 'message', note: result.note, sql: result.sql, trace: result.trace });
        } catch (err) {
          if (!controller.signal.aborted) {
            send({ type: 'error', message: providerMessage(err) });
          }
        } finally {
          runningStreams.delete(streamId);
        }
      })();

      return { streamId };
    },
  );

  registerHandler('ai:chat:cancel', ({ streamId }: { streamId: string }) => {
    const controller = runningStreams.get(streamId);
    // Cancelling a stream that already finished is normal — the panel aborts on unmount
    // without knowing whether the answer landed first.
    if (controller) {
      controller.abort();
      runningStreams.delete(streamId);
    }
    return { ok: true };
  });
}
