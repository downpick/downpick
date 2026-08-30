import type {
  AiConversationDetail,
  AiConversationSummary,
  AiHistoryCursor,
  AiHistoryMessage,
  AiHistoryPage,
  AiStreamEvent,
  Channel,
  ClipboardWriteRequest,
  NotifyResult,
  PickVaultFileRequest,
  PickVaultFileResult,
  QueryFinishedNotice,
  SaveFileRequest,
  StoredAiHistoryMessage,
  TestNotificationResult,
} from '../../server/channels';
import type { DbType } from './store';

/**
 * Every call the UI makes goes through the preload bridge to the main process.
 *
 * There is no HTTP client here anymore, and no session token: the bearer token, the 401
 * re-mint, and the origin dance all existed to protect a loopback port that no longer
 * exists. What survives is the shape — `invoke<T>` behaves exactly like the old
 * `request<T>`, including the 423 lock hook and the `line` property on query errors, so
 * nothing downstream of this file had to change.
 */

/**
 * Notified when the main process reports the vault as locked (status 423), so the shell can
 * put the unlock dialog up from wherever the call happened to originate.
 */
type LockListener = () => void;
let onLocked: LockListener = () => {};

export function setLockListener(listener: LockListener): void {
  onLocked = listener;
}

/** An error carrying the status and, for query failures, the offending line. */
export interface ApiError extends Error {
  status?: number;
  line?: number;
  /** Machine-readable tag for the failures the UI branches on — see QUERY_TIMEOUT. */
  code?: string;
}

async function invoke<T>(channel: Channel, payload?: unknown): Promise<T> {
  const envelope = await window.downpick.invoke<T>(channel, payload);
  if (envelope.ok) return envelope.data;

  // vault:* channels answer while locked by design — raising the unlock dialog in response
  // to the unlock screen's own call would be a loop.
  if (envelope.status === 423 && !channel.startsWith('vault:')) {
    onLocked();
  }

  const err: ApiError = new Error(envelope.error);
  err.status = envelope.status;
  if (envelope.line != null) err.line = envelope.line;
  if (envelope.code != null) err.code = envelope.code;
  throw err;
}

/**
 * Writes a file through the native save dialog.
 *
 * Resolves to false when the user dismissed the dialog, which is not an error and should
 * leave the UI untouched.
 */
/**
 * Puts text (and optionally an HTML flavour) on the system clipboard.
 *
 * Rejects if main could not write it — the caller decides what to tell the user.
 */
export async function copyToClipboard(request: ClipboardWriteRequest): Promise<void> {
  await invoke<{ ok: boolean }>('clipboard:write', request);
}

export async function saveFile(request: SaveFileRequest): Promise<boolean> {
  const envelope = await window.downpick.saveFile(request);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data.saved;
}

export type AiProviderKind =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai_compatible'
  | 'azure_openai';

export interface AiProviderDefinition {
  kind: AiProviderKind;
  label: string;
  requiresBaseUrl: boolean;
  baseUrlLabel?: string;
  baseUrlPlaceholder?: string;
  models: string[];
}

/** A configured provider as the server reports it — never carries the API key. */
export interface AiProviderInfo {
  id: string;
  provider: AiProviderKind;
  label: string;
  baseUrl?: string;
  models: string[];
}

export interface AiProvidersResponse {
  catalog: AiProviderDefinition[];
  providers: AiProviderInfo[];
}

/** One prior exchange, replayed so follow-up questions keep their context. */
export interface AiHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  sql?: string | null;
}

export type { AiStreamEvent };
export type { PickVaultFileRequest, PickVaultFileResult };
export type {
  AiConversationDetail,
  AiConversationSummary,
  AiHistoryCursor,
  AiHistoryMessage,
  AiHistoryPage,
  StoredAiHistoryMessage,
};

export interface AppSettings {
  vaultFilePath: string;
  defaultVaultPath: string;
  queryTimeoutSeconds: number;
  autoLockMinutes: number;
  notifyOnQueryFinish: boolean;
  notifyAfterSeconds: number;
  fileExists: boolean;
  valid: boolean;
  error?: string;
}

export interface VaultStatus {
  initialized: boolean;
  locked: boolean;
  path: string;
}

export interface TestConnectionResult {
  ok: boolean;
  elapsedMs?: number;
  error?: string;
}

export interface ValidationResult {
  fileExists: boolean;
  valid: boolean;
  error?: string;
}

export const api = {
  listConnections: () => invoke<import('./store').SavedConnection[]>('connections:list'),
  createConnection: (body: {
    name: string;
    type: DbType;
    host: string;
    port: number;
    /** Oracle only; ignored by every other engine. */
    serviceName?: string;
    username: string;
    password: string;
  }) => invoke<{ id: string }>('connections:create', body),
  updateConnection: (id: string, body: {
    name: string;
    type: DbType;
    host: string;
    port: number;
    serviceName?: string;
    username: string;
    password?: string;
  }) => invoke<{ ok: boolean }>('connections:update', { id, ...body }),
  deleteConnection: (id: string) => invoke<{ ok: boolean }>('connections:delete', { id }),
  testConnection: (body: {
    // Present when testing an existing profile — lets the main process fall back to the
    // stored password if the user left the field blank.
    id?: string;
    type: DbType;
    host: string;
    port: number;
    // Same fallback rule as the password: blank on an existing profile means "use the stored one".
    serviceName?: string;
    username: string;
    password?: string;
  }) => invoke<TestConnectionResult>('connections:test', body),
  connect: (id: string) => invoke<{ databases: string[] }>('connections:connect', { id }),
  disconnect: (id: string) => invoke<{ ok: boolean }>('connections:disconnect', { id }),
  openDatabase: (connId: string, database: string) =>
    invoke<import('./store').SchemaTree>('connections:openDb', { id: connId, database }),
  query: (connectionId: string, database: string, sql: string, queryId?: string) =>
    invoke<import('./store').QueryResult>('query:run', { connectionId, database, sql, queryId }),
  cancelQuery: (queryId: string) => invoke<{ ok: boolean }>('query:cancel', { queryId }),
  schema: (connectionId: string, database: string) =>
    invoke<import('./store').SchemaTree>('schema:get', { connectionId, database }),

  // Vault. `vaultFilePath` is only passed by the first-run screen, where the user picks which
  // vault to create or open; everywhere else the configured path is already the right one.
  vaultStatus: () => invoke<VaultStatus>('vault:status'),
  vaultSetup: (password: string, vaultFilePath?: string) =>
    invoke<{ ok: boolean }>('vault:setup', { password, vaultFilePath }),
  vaultUnlock: (password: string, vaultFilePath?: string) =>
    invoke<{ ok: boolean }>('vault:unlock', { password, vaultFilePath }),
  vaultLock: () => invoke<{ ok: boolean }>('vault:lock'),
  vaultChangePassword: (currentPassword: string, newPassword: string) =>
    invoke<{ ok: boolean }>('vault:changePassword', { currentPassword, newPassword }),

  // Settings
  getSettings: () => invoke<AppSettings>('settings:get'),
  // One object rather than positional arguments: the handler already takes a patch, and a
  // fifth positional `boolean, number` tail would be unreadable at the call site.
  updateSettings: (patch: {
    vaultFilePath: string;
    queryTimeoutSeconds?: number;
    autoLockMinutes?: number;
    notifyOnQueryFinish?: boolean;
    notifyAfterSeconds?: number;
  }) => invoke<{ ok: boolean } & ValidationResult>('settings:update', patch),
  validateSettingsPath: (path: string) =>
    invoke<ValidationResult>('settings:validate', { path }),
  /**
   * Report a finished query. Main decides whether it is worth announcing and how — the reply
   * says whether the renderer still owes the user a toast.
   */
  notifyQueryFinished: (notice: QueryFinishedNotice) =>
    invoke<NotifyResult>('notify:queryFinished', notice),

  /**
   * Raise a notification right now, ignoring the threshold and the enable switch. Backs the
   * "Send a test notification" button — the only way to find out whether the OS lets them
   * through, since a denied notification fails silently.
   */
  sendTestNotification: () => invoke<TestNotificationResult>('notify:test'),

  /** Native file dialog for choosing a vault. Answers while the vault is still locked. */
  pickVaultFile: (body: PickVaultFileRequest) =>
    invoke<PickVaultFileResult>('files:pickVault', body),

  // AI providers
  aiProviders: () => invoke<AiProvidersResponse>('ai:providers:list'),
  addAiProvider: (body: {
    provider: AiProviderKind;
    label: string;
    baseUrl?: string;
    apiKey: string;
    models: string[];
  }) => invoke<AiProviderInfo>('ai:providers:add', body),
  updateAiProvider: (
    id: string,
    body: { label?: string; baseUrl?: string; apiKey?: string; models?: string[] },
  ) => invoke<AiProviderInfo>('ai:providers:update', { id, ...body }),
  deleteAiProvider: (id: string) => invoke<{ ok: boolean }>('ai:providers:delete', { id }),
  /**
   * Ask a provider which models the key can use. Pass `id` for a saved provider (the stored
   * key is used) or `provider` + `apiKey` for one still being filled in. Rejects with the
   * provider's own message when listing is not permitted, which is common on Azure.
   */
  discoverAiModels: (body: {
    id?: string;
    provider?: AiProviderKind;
    baseUrl?: string;
    apiKey?: string;
  }) => invoke<{ models: string[] }>('ai:providers:models', body),

  // Ask AI history. Stored in ~/.downpick/chats.db, outside the vault — see SECURITY.md.
  aiHistoryList: (body?: { limit?: number; before?: AiHistoryCursor | null }) =>
    invoke<AiHistoryPage>('ai:history:list', body ?? {}),
  aiHistoryGet: (id: string) => invoke<AiConversationDetail>('ai:history:get', { id }),
  /**
   * Upserts a conversation and replaces its transcript wholesale. `conversationId` is null
   * on the first save of a chat; the id that comes back is what links the tab to the row.
   * A null id in the reply means history is unavailable, not that the call failed.
   */
  aiHistorySave: (body: {
    conversationId: string | null;
    connectionId: string;
    connectionName: string;
    database: string;
    messages: AiHistoryMessage[];
  }) => invoke<{ id: string | null }>('ai:history:save', body),
  aiHistoryDelete: (id: string) => invoke<{ ok: boolean }>('ai:history:delete', { id }),
  aiHistoryClear: () => invoke<{ ok: boolean; deleted: number }>('ai:history:clear'),
};

function abortError(): Error {
  // The consumer distinguishes an abort from a real failure by checking its own signal, so
  // any thrown value works — but the name keeps it recognizable in a stack trace.
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Streams one AI answer.
 *
 * Kept as an async generator with the exact signature it had over NDJSON, so the panel that
 * consumes it did not have to change. Underneath, `ai:chat:start` returns a stream id and the
 * main process pushes each step as an event; this turns that back into a sequence.
 *
 * Events are buffered from the moment the subscription is live — before the start call is
 * even sent — because nothing guarantees the id arrives back here before the agent's first
 * step goes out. Anything for another stream is discarded once the id is known.
 */
export async function* aiChatStream(
  body: {
    providerId: string;
    model: string;
    connectionId: string;
    database: string;
    question: string;
    history: AiHistoryEntry[];
    /**
     * What the tab's editor held when the question was sent — the whole buffer, or just the
     * selection. Captured here rather than fetched later because the tool that serves it runs
     * in the main process, which has no way to reach back into the editor mid-answer.
     */
    editor?: { text: string; isSelection: boolean } | null;
  },
  signal?: AbortSignal,
): AsyncGenerator<AiStreamEvent> {
  let streamId: string | null = null;
  const queue: AiStreamEvent[] = [];
  const unmatched: { streamId: string; event: AiStreamEvent }[] = [];
  let wake: (() => void) | null = null;
  let aborted = false;

  const ring = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const unsubscribe = window.downpick.onAiChat((payload) => {
    if (streamId === null) unmatched.push(payload);
    else if (payload.streamId === streamId) queue.push(payload.event);
    else return;
    ring();
  });

  const onAbort = () => {
    aborted = true;
    ring();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    if (signal?.aborted) throw abortError();

    // Everything checkable up front still rejects up front — a missing model or an
    // unconfigured provider throws from here exactly as it used to.
    ({ streamId } = await invoke<{ streamId: string }>('ai:chat:start', body));

    // Drain whatever arrived while the id was in flight.
    for (const payload of unmatched) {
      if (payload.streamId === streamId) queue.push(payload.event);
    }
    unmatched.length = 0;

    for (;;) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        yield event;
        // `message` and `error` are both terminal — the agent has nothing left to send.
        if (event.type !== 'step') return;
      }
      if (aborted) throw abortError();
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    // Covers the abort and the early-`break` cases alike: whatever the reason this generator
    // is done, the provider call behind it should stop costing money.
    if (streamId) void invoke('ai:chat:cancel', { streamId }).catch(() => {});
  }
}
