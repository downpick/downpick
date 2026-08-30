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
  'files:pickVault',
  'clipboard:write',
  'notify:queryFinished',
  'notify:test',
] as const;

export type Channel = (typeof CHANNELS)[number];

/**
 * Channels that answer while the vault is locked.
 *
 * Ported verbatim from the Fastify vault gate: the shell needs `settings:get` to render the
 * unlock screen, and settings live in settings.json outside the vault, so reading them
 * cannot require it to be open. `files:save` is a renderer-driven save dialog that carries
 * its own payload and touches no secret.
 *
 * `files:pickVault` has to answer while locked by definition — it is how the first-run screen
 * asks which vault to open before any vault is open. It is not the filesystem oracle
 * `settings:validate` would be if it were exempt: the path comes back from the OS dialog the
 * user drove, never from one the renderer composed.
 */
export const UNLOCKED_NOT_REQUIRED: readonly Channel[] = [
  'vault:status',
  'vault:setup',
  'vault:unlock',
  'vault:lock',
  'vault:changePassword',
  'settings:get',
  'files:save',
  'files:pickVault',
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
  | { ok: false; status: number; error: string; line?: number; code?: string };

/**
 * `code` on a failed envelope, for the one failure the UI must recognise rather than read.
 *
 * A query the configured timeout cancelled comes back as a 400 like any other rejected query,
 * so notifying on a timeout but not on a syntax error would otherwise mean matching the text
 * of "Query timed out after 30s" — which breaks the day that sentence is reworded.
 */
export const QUERY_TIMEOUT = 'QUERY_TIMEOUT';

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
  /** The user clicked a native query notification; the renderer brings that tab forward. */
  notificationActivate: 'notification:activate',
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
  | 'query:runStatement'
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
 * Payload for `files:pickVault` — the native file dialog behind the first-run vault screen.
 *
 * Two modes rather than two channels, because they differ only in which Electron dialog is
 * shown: `open` picks a vault that already exists, `create` picks where a new one will be
 * written. Neither touches the file; both only hand a path back.
 */
export interface PickVaultFileRequest {
  mode: 'open' | 'create';
  /** Where the dialog starts. Usually the currently configured vault path. */
  defaultPath?: string;
}

export interface PickVaultFileResult {
  /** True when the user dismissed the dialog — a normal outcome, not an error. */
  canceled: boolean;
  path?: string;
  /**
   * Only for `open`: whether the chosen file is a vault this build can read. Validating here
   * rather than through `settings:validate` keeps that channel behind the vault gate — the
   * user chose this path in the OS dialog, so answering for it reveals nothing they did not
   * already know.
   */
  fileExists?: boolean;
  valid?: boolean;
  error?: string;
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

/**
 * Payload for `notify:queryFinished` — "this query is done, say so if it is worth saying".
 *
 * The renderer reports the outcome; main decides what to do with it, because everything the
 * decision needs lives there: the threshold in settings.json, and whether the window is
 * actually in front of the user. The renderer cannot answer the second one honestly —
 * `document.hasFocus()` is about the document, not about which application the user is
 * looking at — and having it read settings just to compare a number would put the rule in
 * two places.
 *
 * `detail` arrives pre-formatted rather than as raw counts so the notification body and the
 * status bar say the same thing; both go through `summarizeResult`.
 */
export interface QueryFinishedNotice {
  /** Which tab ran it, so clicking the notification can bring that tab forward. */
  tabId: string;
  outcome: 'success' | 'timeout';
  connectionName: string;
  database: string;
  /** Wall-clock time the run took, measured around the whole call. */
  elapsedMs: number;
  /** "1,240 rows · 2m 13s", or the timeout message. */
  detail: string;
}

/**
 * What main actually did. The renderer draws its own toast only for `'toast'` — otherwise a
 * background query would announce itself twice, once on the desktop and once behind it.
 */
export interface NotifyResult {
  shown: 'native' | 'toast' | 'none';
}

/**
 * Reply to `notify:test` — the Settings button that raises a notification on demand.
 *
 * `sent` only means the OS accepted it, never that the user saw it: when notifications are
 * denied for the app, macOS swallows `show()` in silence and emits no `failed` event either,
 * so there is nothing to report. Whether it actually appeared is a question only the person
 * looking at the screen can answer, which is the whole reason the button exists.
 */
export interface TestNotificationResult {
  /** False when this platform has no notification system at all. */
  supported: boolean;
  sent: boolean;
}

/** Payload of `notification:activate`. */
export interface NotificationActivateEvent {
  tabId: string;
}
