import { randomUUID } from 'crypto';
import {
  AiConversationDetail,
  AiConversationSummary,
  AiHistoryCursor,
  AiHistoryMessage,
  AiHistoryPage,
  StoredAiHistoryMessage,
} from './channels';
import { transaction, withDb } from './chats/db';

/**
 * Ask AI conversation history, shaped like `aiProviders.ts`: thin domain functions over the
 * storage layer, owning the types that cross IPC and the mapping to them.
 *
 * That mapping is not optional. `node:sqlite` hands back null-prototype row objects, and
 * `dispatch.ts` round-trips every reply through JSON — so rows are copied into plain objects
 * here rather than passed along, which the snake_case columns would have required anyway.
 *
 * Unlike providers, none of this is secret, and none of it is in the vault. The transcripts
 * sit unencrypted in `~/.downpick/chats.db`; SECURITY.md says so out loud.
 */

/** Longest title kept for a conversation. Titles are derived, never user-supplied. */
const TITLE_MAX_LENGTH = 120;

const TITLE_FALLBACK = 'Untitled chat';

export type {
  AiConversationDetail,
  AiConversationSummary,
  AiHistoryCursor,
  AiHistoryPage,
  StoredAiHistoryMessage,
} from './channels';

/** What the handler hands in: a message with its runtime-only fields already stripped. */
export type AiMessageInput = AiHistoryMessage;

const SUMMARY_COLUMNS = `
  c.id, c.title, c.connection_id, c.connection_name, c.database_name,
  c.created_at, c.updated_at,
  (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
`;

const LIST_FIRST = `SELECT ${SUMMARY_COLUMNS} FROM conversations c
  ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`;

// Two statements rather than one with an `IS NULL` guard: anonymous `?` binds positionally,
// and mixing numbered parameters in to reuse a single string is a footgun for no gain.
const LIST_AFTER = `SELECT ${SUMMARY_COLUMNS} FROM conversations c
  WHERE c.updated_at < ? OR (c.updated_at = ? AND c.id < ?)
  ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`;

const GET_CONVERSATION = `SELECT ${SUMMARY_COLUMNS} FROM conversations c WHERE c.id = ?`;

const GET_MESSAGES = `SELECT seq, role, text, sql, trace, is_error
  FROM messages WHERE conversation_id = ? ORDER BY seq`;

/**
 * The connection and database columns are written once and never updated. They record where
 * a conversation *started*, which is what keeps its label in the history list stable — the
 * alternative, stamping the newest database, makes a row silently relabel itself. The cost
 * is that resuming a conversation against another database leaves one row whose later turns
 * targeted somewhere other than its label; the panel shows a notice when that happens.
 */
const UPSERT_CONVERSATION = `INSERT INTO conversations
  (id, title, connection_id, connection_name, database_name, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`;

const DELETE_MESSAGES = 'DELETE FROM messages WHERE conversation_id = ?';

const INSERT_MESSAGE = `INSERT INTO messages
  (conversation_id, seq, role, text, sql, trace, is_error, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** One row of the summary select, as SQLite hands it over. */
interface SummaryRow {
  id: string;
  title: string;
  connection_id: string;
  connection_name: string;
  database_name: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

interface MessageRow {
  seq: number;
  role: string;
  text: string;
  sql: string | null;
  trace: string | null;
  is_error: number;
}

function toSummary(row: SummaryRow): AiConversationSummary {
  return {
    id: row.id,
    title: row.title,
    connectionId: row.connection_id,
    connectionName: row.connection_name,
    database: row.database_name,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Number(row.message_count),
  };
}

function decodeTrace(raw: string | null): { label: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is { label: string } => typeof s?.label === 'string')
      .map((s) => ({ label: s.label }));
  } catch {
    // Hand-edited or written by a future version. A conversation is still worth showing
    // without its trace lines.
    return [];
  }
}

/**
 * Messages have no id column — `(conversation_id, seq)` is the natural key, and the id the
 * client needs is derived from it here. Deterministic, unique across conversations, and
 * shaped so it can never collide with the UUIDs the panel mints for live messages.
 */
function toMessage(conversationId: string, row: MessageRow): StoredAiHistoryMessage {
  return {
    id: `${conversationId}:${row.seq}`,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    text: row.text,
    sql: row.sql,
    trace: decodeTrace(row.trace),
    isError: row.is_error === 1,
  };
}

/** First thing the user asked, flattened onto one line — the closest thing to a subject. */
export function deriveTitle(messages: AiMessageInput[]): string {
  const first = messages.find((m) => m.role === 'user' && m.text.trim());
  if (!first) return TITLE_FALLBACK;
  const flat = first.text.replace(/\s+/g, ' ').trim();
  if (!flat) return TITLE_FALLBACK;
  return flat.length > TITLE_MAX_LENGTH ? `${flat.slice(0, TITLE_MAX_LENGTH - 1)}…` : flat;
}

export function listConversations(opts: {
  limit: number;
  before?: AiHistoryCursor | null;
}): AiHistoryPage {
  const { limit, before } = opts;
  return withDb<AiHistoryPage>(
    (handle) => {
      // One extra row is all it takes to know whether another page exists — cheaper than a
      // second COUNT over a table that only grows.
      const rows = (
        before
          ? handle.prepare(LIST_AFTER).all(before.updatedAt, before.updatedAt, before.id, limit + 1)
          : handle.prepare(LIST_FIRST).all(limit + 1)
      ) as unknown as SummaryRow[];

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(toSummary);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
        available: true,
      };
    },
    { items: [], nextCursor: null, available: false },
  );
}

export function getConversation(id: string): AiConversationDetail | null {
  return withDb<AiConversationDetail | null>((handle) => {
    const row = handle.prepare(GET_CONVERSATION).get(id) as unknown as SummaryRow | undefined;
    if (!row) return null;
    const messages = (handle.prepare(GET_MESSAGES).all(id) as unknown as MessageRow[]).map((m) =>
      toMessage(id, m),
    );
    return { ...toSummary(row), messages };
  }, null);
}

/**
 * Writes a whole transcript, creating the conversation on first save.
 *
 * The messages are replaced wholesale rather than appended. Transcripts are a few KB, and
 * replacing buys three things worth more than the bytes: the renderer needs no notion of
 * which messages it has already saved, a retried save is harmless, and a save that fails —
 * the vault auto-locking mid-session, say — is repaired by the next one instead of leaving
 * a permanent hole.
 *
 * Returns null when history is unavailable; the caller treats that as "not saved", never as
 * an error worth interrupting the user for.
 */
export function saveConversation(input: {
  conversationId: string | null;
  connectionId: string;
  connectionName: string;
  database: string;
  messages: AiMessageInput[];
}): { id: string } | null {
  const { conversationId, connectionId, connectionName, database, messages } = input;
  if (messages.length === 0) return null;

  return withDb<{ id: string } | null>((handle) => {
    const id = conversationId ?? randomUUID();
    const now = Date.now();

    return transaction(handle, () => {
      handle
        .prepare(UPSERT_CONVERSATION)
        .run(id, deriveTitle(messages), connectionId, connectionName, database, now, now);
      handle.prepare(DELETE_MESSAGES).run(id);

      const insert = handle.prepare(INSERT_MESSAGE);
      messages.forEach((message, seq) => {
        insert.run(
          id,
          seq,
          message.role,
          message.text,
          message.sql,
          message.trace.length > 0 ? JSON.stringify(message.trace) : null,
          message.isError ? 1 : 0,
          now,
        );
      });

      return { id };
    });
  }, null);
}

export function deleteConversation(id: string): boolean {
  return withDb((handle) => {
    // Messages go with it through ON DELETE CASCADE.
    const info = handle.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  }, false);
}

export function clearConversations(): number {
  return withDb((handle) => {
    const info = handle.prepare('DELETE FROM conversations').run();
    return Number(info.changes);
  }, 0);
}
