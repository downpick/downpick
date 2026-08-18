/**
 * The IPC surface: every channel the renderer may call, and the events it may receive.
 *
 * This file is the contract between `electron/preload.ts` and `client/src/api.ts`, so it is
 * imported by both the main process and the renderer bundle. Keep it free of runtime
 * dependencies — string constants and types only — or the client build starts pulling
 * database drivers into the browser.
 */

/** Channels the renderer can invoke. Anything not listed here is rejected by the dispatcher. */
export const CHANNELS = [
  'vault:status',
  'vault:setup',
  'vault:unlock',
  'vault:lock',
  'vault:changePassword',

  'connections:list',
  'connections:create',
  'connections:update',
  'connections:delete',
  'connections:test',
  'connections:connect',
  'connections:disconnect',
  'connections:openDb',

  'query:run',
  'query:cancel',

  'schema:get',

  'settings:get',
  'settings:update',
  'settings:validate',

  'ai:providers:list',
  'ai:providers:add',
  'ai:providers:update',
  'ai:providers:delete',
  'ai:providers:models',
  'ai:chat:start',
  'ai:chat:cancel',
  'ai:history:list',
  'ai:history:get',
  'ai:history:save',
  'ai:history:delete',
  'ai:history:clear',

  'files:save',
  'clipboard:write',
] as const;

export type Channel = (typeof CHANNELS)[number];

/**
 * Channels that answer while the vault is locked.
 *
 * Ported verbatim from the Fastify vault gate: the shell needs `settings:get` to render the
 * unlock screen, and settings live in settings.json outside the vault, so reading them
 * cannot require it to be open. `files:save` is a renderer-driven save dialog that carries
 * its own payload and touches no secret.
 */
export const UNLOCKED_NOT_REQUIRED: readonly Channel[] = [
  'vault:status',
  'vault:setup',
  'vault:unlock',
  'vault:lock',
  'vault:changePassword',
  'settings:get',
  'files:save',
];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/**
 * What every `invoke` resolves to.
 *
 * Errors are *returned*, never thrown across the boundary: Electron rewrites a thrown
 * error's message into "Error invoking remote method ...", which would bury the messages
 * this app works hard to make actionable. The renderer rebuilds a real Error from `error`.
 */
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; line?: number };

/**
 * The single `ipcMain.handle` channel every call is tunnelled through.
 *
 * One handle rather than one per channel, so the dispatcher's allowlist and vault gate are
 * impossible to route around: there is no second door to forget to lock.
 */
export const IPC_INVOKE = 'downpick:invoke';

/** Event names pushed from main to the renderer. */
export const EVENTS = {
  /** One NDJSON-equivalent event from a running AI answer. */
  aiChat: 'ai:chat:event',
  /** A menu item was activated; the renderer routes it to the matching in-app action. */
  menuCommand: 'menu:command',
} as const;

export type AiStreamEvent =
  | { type: 'step'; label: string }
  | { type: 'message'; note: string; sql: string | null; trace: { label: string }[] }
  | { type: 'error'; message: string };

export interface AiChatEvent {
  streamId: string;
  event: AiStreamEvent;
}

/**
 * Saved Ask AI history.
 *
 * These live in `~/.downpick/chats.db`, not the vault — see SECURITY.md. Declared here so
 * the renderer and the handlers share one definition, the way `AiStreamEvent` already is.
 */
export interface AiHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  sql: string | null;
  trace: { label: string }[];
  isError: boolean;
}

/** A message as it comes back out of storage, carrying the id derived from its position. */
export interface StoredAiHistoryMessage extends AiHistoryMessage {
  id: string;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  connectionId: string;
  /** Where the conversation started. Never rewritten, so its label in the list is stable. */
  connectionName: string;
  database: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AiConversationDetail extends AiConversationSummary {
  messages: StoredAiHistoryMessage[];
}

/** Where a page of history stopped. Carries `id` as well, because timestamps tie. */
export interface AiHistoryCursor {
  updatedAt: number;
  id: string;
}

export interface AiHistoryPage {
  items: AiConversationSummary[];
  nextCursor: AiHistoryCursor | null;
  /** False when chats.db could not be opened — "unavailable" rather than "no chats". */
  available: boolean;
}

export type MenuCommand =
  | 'query:run'
  | 'query:cancel'
  | 'query:format'
  | 'vault:lock'
  | 'connection:new'
  | 'settings:open'
  | 'settings:ai';

/** Payload for `files:save` — the renderer builds the bytes, main owns the dialog and the write. */
export interface SaveFileRequest {
  defaultName: string;
  /** Passed straight to Electron's dialog filters, e.g. `[{ name: 'CSV', extensions: ['csv'] }]`. */
  filters: { name: string; extensions: string[] }[];
  /** File contents. Uint8Array survives structured clone intact. */
  data: Uint8Array;
}

export interface SaveFileResult {
  /** False when the user dismissed the dialog — not an error. */
  saved: boolean;
  path?: string;
}

/**
 * Payload for `clipboard:write`.
 *
 * The renderer cannot use `navigator.clipboard`: the session denies every permission,
 * including `clipboard-sanitized-write`, so the web API always rejects. Main writes both
 * flavours in one go — `html` so spreadsheets and chat apps paste a real table, `text` as
 * the TSV every other target falls back to.
 */
export interface ClipboardWriteRequest {
  text: string;
  html?: string;
}
