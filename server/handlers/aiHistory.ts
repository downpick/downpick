import {
  AiMessageInput,
  clearConversations,
  deleteConversation,
  getConversation,
  listConversations,
  saveConversation,
} from '../aiChats';
import { AiHistoryCursor } from '../channels';
import { AppError, registerHandler } from '../dispatch';

/**
 * Saved Ask AI conversations.
 *
 * Kept out of `ai.ts`, which is already carrying providers and the streaming agent, and
 * because `registerAllHandlers` is built to take one call per module.
 *
 * The caps below are not decoration. `chats/db.ts` writes synchronously on the main process
 * event loop, so the only thing bounding how long a save can stall the app is how much the
 * renderer is allowed to hand over in one call.
 */

const MAX_MESSAGES = 200;
const MAX_MESSAGE_TEXT = 20_000;
const MAX_SQL_LENGTH = 20_000;
const MAX_TRACE_STEPS = 20;
const MAX_TRACE_LABEL = 300;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function parseTrace(value: unknown): { label: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is { label: string } => typeof (s as { label?: unknown })?.label === 'string')
    .slice(0, MAX_TRACE_STEPS)
    .map((s) => ({ label: clamp(s.label, MAX_TRACE_LABEL) }));
}

/**
 * Coerces a transcript off the wire, in the same spirit as `parseHistory` in ai.ts: anything
 * malformed is dropped and anything oversized is truncated, rather than failing the call.
 * A save is a background side effect of asking a question — rejecting one outright would
 * surface an error the user cannot act on, in the middle of reading an answer.
 */
export function parseMessages(value: unknown): AiMessageInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is AiMessageInput => {
      const message = m as Partial<AiMessageInput>;
      return (
        (message?.role === 'user' || message?.role === 'assistant') &&
        typeof message.text === 'string'
      );
    })
    .slice(0, MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      text: clamp(m.text, MAX_MESSAGE_TEXT),
      sql: typeof m.sql === 'string' ? clamp(m.sql, MAX_SQL_LENGTH) : null,
      trace: parseTrace(m.trace),
      isError: m.isError === true,
    }));
}

function parseLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function parseCursor(value: unknown): AiHistoryCursor | null {
  const cursor = value as Partial<AiHistoryCursor> | null | undefined;
  if (!cursor || typeof cursor.id !== 'string' || !Number.isFinite(cursor.updatedAt)) return null;
  return { updatedAt: Number(cursor.updatedAt), id: cursor.id };
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, 'A conversation id is required.');
  return value;
}

export function registerAiHistoryHandlers(): void {
  registerHandler('ai:history:list', (body: { limit?: unknown; before?: unknown }) =>
    listConversations({ limit: parseLimit(body?.limit), before: parseCursor(body?.before) }),
  );

  registerHandler('ai:history:get', (body: { id?: unknown }) => {
    const conversation = getConversation(requireId(body?.id));
    // A 404 rather than null: the panel only asks for ids the list just handed it, so a miss
    // means the conversation was deleted from another tab and the list is stale.
    if (!conversation) throw new AppError(404, 'That conversation is no longer saved.');
    return conversation;
  });

  registerHandler(
    'ai:history:save',
    (body: {
      conversationId?: unknown;
      connectionId?: unknown;
      connectionName?: unknown;
      database?: unknown;
      messages?: unknown;
    }) => {
      const { conversationId, connectionId, connectionName, database, messages } = body ?? {};
      if (typeof connectionId !== 'string' || typeof database !== 'string') {
        throw new AppError(400, 'connectionId and database are required.');
      }

      const parsed = parseMessages(messages);
      if (parsed.length === 0) throw new AppError(400, 'There is nothing to save.');

      const saved = saveConversation({
        conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
        connectionId,
        connectionName: typeof connectionName === 'string' ? connectionName : '',
        database,
        messages: parsed,
      });

      // Storage is unavailable — a corrupt or unwritable chats.db. Reported as a soft
      // failure so the panel can drop it silently; the answer on screen is unaffected.
      if (!saved) return { id: null };
      return { id: saved.id };
    },
  );

  registerHandler('ai:history:delete', (body: { id?: unknown }) => {
    if (!deleteConversation(requireId(body?.id))) {
      throw new AppError(404, 'That conversation is no longer saved.');
    }
    return { ok: true };
  });

  registerHandler('ai:history:clear', () => ({ ok: true, deleted: clearConversations() }));
}
