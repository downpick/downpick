import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CHATS_DB_PATH, ensureSecureDir } from '../paths';

/**
 * SQLite mechanics for Ask AI history. Schema and domain shapes live in `../aiChats.ts`;
 * this file knows only how to open the file, migrate it, and run work against it.
 *
 * Two things set it apart from `vault/store.ts`, both deliberate:
 *
 * `node:sqlite` has no async API, so every write blocks the main process event loop for the
 * length of one small transaction — which also stalls query dispatch and AI stream events.
 * That is acceptable only because `handlers/aiHistory.ts` caps how much can arrive in one
 * call; without those caps this would be the wrong module to write synchronously.
 *
 * And nothing here throws. A corrupt or unopenable database degrades to "history is
 * unavailable" rather than taking the panel down with it — the same contract `settings.ts`
 * has, where an unreadable file yields defaults instead of a failed launch.
 */

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  connection_id   TEXT    NOT NULL,
  connection_name TEXT    NOT NULL,
  database_name   TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS conversations_recent
  ON conversations (updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT    NOT NULL,
  sql             TEXT,
  trace           TEXT,
  is_error        INTEGER NOT NULL CHECK (is_error IN (0, 1)),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
) STRICT;
`;

let dbPath = DEFAULT_CHATS_DB_PATH;
let db: DatabaseSync | null = null;

/**
 * Why the last open failed, and the latch that stops us retrying it on every keystroke.
 * Cleared only by `setChatsDbPath`, so a broken file stays broken for the session rather
 * than paying a failed open per call.
 */
let openError: Error | null = null;

export function getChatsDbPath(): string {
  return dbPath;
}

/**
 * Points the store at another file, closing whatever is open first — the same shape as
 * `vault.setVaultPath`, and for the same reason: it is the seam the tests drive, and a
 * live handle to the old path would otherwise outlive the switch.
 */
export function setChatsDbPath(next: string): void {
  if (next === dbPath) return;
  closeChats();
  dbPath = next;
}

export function closeChats(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed, or the handle died with the file. Nothing left to release.
    }
    db = null;
  }
  openError = null;
}

/**
 * Brings the schema up to date.
 *
 * `PRAGMA user_version` rather than a meta table: there is no migration framework in this
 * repo, and a table tracking versions would itself be a thing to migrate. Future versions
 * append another `if` — the pragma is only written once, at the end.
 */
function migrate(handle: DatabaseSync): void {
  const { user_version: version } = handle.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (version >= SCHEMA_VERSION) return;

  if (version < 1) handle.exec(SCHEMA_V1);

  // Pragmas cannot take a bound parameter, so this has to be interpolated. SCHEMA_VERSION
  // is a module constant a line above — there is no input here to inject.
  handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function open(): DatabaseSync | null {
  if (db) return db;
  if (openError) return null;

  let handle: DatabaseSync | null = null;
  try {
    ensureSecureDir(path.dirname(dbPath));
    // The default busy timeout is 0, which fails instantly on SQLITE_BUSY. A single
    // instance is enforced elsewhere, so this only ever covers a dev build running
    // alongside a packaged one.
    handle = new DatabaseSync(dbPath, { timeout: 5000 });
    // A garbage file opens without complaint — SQLite only reads the header when the first
    // statement runs, so this is where "not a database" actually surfaces.
    migrate(handle);
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // No-op on Windows, and can fail on a network filesystem. The 0700 directory is the
      // real boundary; this is the same defence in depth the vault file gets.
    }
    db = handle;
    return db;
  } catch (err) {
    // Closing a handle we are abandoning: migrate() can fail after the constructor
    // succeeded, and that file descriptor would otherwise leak for the session.
    try {
      handle?.close();
    } catch {
      /* nothing to do */
    }
    openError = err instanceof Error ? err : new Error(String(err));
    // Deliberately no attempt to move, rename, or recreate the file. It may be the user's
    // only copy of their history, and destroying it to recover from a read error is the
    // one irreversible thing this module could do.
    return null;
  }
}

/** True when history is usable. A false here is what the UI turns into "unavailable". */
export function isAvailable(): boolean {
  return open() !== null;
}

/**
 * Runs `fn` against the database, or returns `fallback` if it cannot be opened or the
 * statement fails. A statement-level failure is not latched — one bad row should not
 * disable history for the rest of the session.
 */
export function withDb<T>(fn: (handle: DatabaseSync) => T, fallback: T): T {
  const handle = open();
  if (!handle) return fallback;
  try {
    return fn(handle);
  } catch {
    return fallback;
  }
}

/** Wraps `fn` in BEGIN/COMMIT, rolling back on any throw. */
export function transaction<T>(handle: DatabaseSync, fn: () => T): T {
  handle.exec('BEGIN');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // The transaction is already gone; the original error is the one worth reporting.
    }
    throw err;
  }
}
