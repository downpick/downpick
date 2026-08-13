import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_VAULT_PATH, ensureSecureDir } from '../paths';
import {
  createVault,
  openVault,
  rewrapVault,
  serializeVault,
  VaultCorruptError,
  VaultKeys,
} from './crypto';
import { emptyPayload, normalizePayload, VaultPayload } from './types';

export { DEFAULT_VAULT_PATH };

let vaultPath = DEFAULT_VAULT_PATH;

export function getVaultPath(): string {
  return vaultPath;
}

export function setVaultPath(next: string): void {
  if (next !== vaultPath) {
    lockNow();
    vaultPath = next;
    lastWriteSeq = 0;
    lastWrittenMtimeMs = 0;
  }
}

type State = { status: 'locked' } | { status: 'unlocked'; keys: VaultKeys; payload: VaultPayload };

let state: State = { status: 'locked' };

/**
 * Highest write sequence this process has seen. GCM proves a file was not edited, but it
 * cannot tell a current file from an intact older copy of itself, so whole-envelope
 * rollback — restoring a `.bak` to bring back a deleted connection or an old API key —
 * needs state kept outside the file. This catches it for as long as the app is running;
 * an attacker who swaps the file while the app is stopped is not detectable from the file
 * alone, and that limit is documented rather than papered over.
 */
let lastWriteSeq = 0;

/** mtime of the file as we last wrote or read it, used to spot edits from another process. */
let lastWrittenMtimeMs = 0;

/** Serializes every mutation. Two tabs saving at once used to silently lose data; with a
 * single file holding every secret, a lost write is now a much larger blast radius. */
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

/** Closes live database drivers when the vault locks. Wired up by the server entry point
 * to avoid a circular import between the store and the connection routes. */
type LockHandler = () => Promise<void>;
let lockHandler: LockHandler | null = null;

export function setLockHandler(handler: LockHandler): void {
  lockHandler = handler;
}

export function isInitialized(): boolean {
  return fs.existsSync(vaultPath);
}

export function isLocked(): boolean {
  return state.status === 'locked';
}

export function getStatus(): { initialized: boolean; locked: boolean } {
  return { initialized: isInitialized(), locked: isLocked() };
}

function backupPath(): string {
  return `${vaultPath}.bak`;
}

function writeAtomic(contents: string): void {
  const dir = path.dirname(vaultPath);
  ensureSecureDir(dir);

  // The temp file must live in the same directory: rename is only atomic within a
  // filesystem. 'wx' refuses to reuse an existing file, so a leftover from a crashed run
  // can never contribute its own permissions.
  const tmp = path.join(dir, `.${path.basename(vaultPath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, contents, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(vaultPath)) {
    fs.copyFileSync(vaultPath, backupPath());
  }
  fs.renameSync(tmp, vaultPath);

  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync raises EPERM on Windows, which is a shipped target. The rename
    // itself has already happened; only the durability barrier is missing.
  }

  lastWrittenMtimeMs = fs.statSync(vaultPath).mtimeMs;
}

function readVaultFile(): string {
  const raw = fs.readFileSync(vaultPath, 'utf-8');
  lastWrittenMtimeMs = fs.statSync(vaultPath).mtimeMs;
  return raw;
}

function assertNotRolledBack(payload: VaultPayload): void {
  if (payload.writeSeq < lastWriteSeq) {
    throw new VaultCorruptError(
      'it is older than the copy this session already loaded, which means it was replaced or restored from a backup',
    );
  }
  lastWriteSeq = payload.writeSeq;
}

/**
 * Refuses to overwrite a file that changed underneath us. The vault is held decrypted in
 * memory rather than re-read on every access, so a file edited elsewhere — a second
 * instance, or a cloud sync — would be silently discarded by a blind write.
 */
function assertNotChangedOnDisk(): void {
  if (!fs.existsSync(vaultPath)) return;
  const current = fs.statSync(vaultPath).mtimeMs;
  if (lastWrittenMtimeMs && current !== lastWrittenMtimeMs) {
    throw new Error(
      'The vault file changed on disk since it was opened. Reload the app so the newer version is not overwritten.',
    );
  }
}

export function createVaultFile(password: string, initial: VaultPayload = emptyPayload()): Promise<void> {
  return exclusive(async () => {
    if (isInitialized()) {
      throw new Error('A vault already exists at this location.');
    }
    const payload = { ...initial, writeSeq: initial.writeSeq + 1 };
    const { keys, serialized } = await createVault(password, Buffer.from(JSON.stringify(payload), 'utf-8'));
    writeAtomic(serialized);
    lastWriteSeq = payload.writeSeq;
    state = { status: 'unlocked', keys, payload };
    touch();
  });
}

export function unlock(password: string): Promise<void> {
  return exclusive(async () => {
    if (!isInitialized()) {
      throw new Error('No vault exists yet.');
    }
    const { keys, plaintext } = await openVault(readVaultFile(), password);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString('utf-8'));
    } catch {
      throw new VaultCorruptError('the decrypted contents are not valid JSON');
    } finally {
      plaintext.fill(0);
    }
    const payload = normalizePayload(parsed);
    assertNotRolledBack(payload);
    state = { status: 'unlocked', keys, payload };
    touch();
  });
}

/** Synchronous half of locking: forget the key material. */
function lockNow(): void {
  if (state.status === 'unlocked') {
    state.keys.dek.fill(0);
  }
  state = { status: 'locked' };
  stopAutoLockTimer();
}

export async function lock(): Promise<void> {
  lockNow();
  // Without this the lock would be theatre: the drivers stay connected and every open
  // database remains queryable with the vault supposedly shut.
  if (lockHandler) await lockHandler();
}

export function changePassword(current: string, next: string): Promise<void> {
  return exclusive(async () => {
    if (state.status !== 'unlocked') throw new Error('The vault is locked.');
    // Re-open from disk rather than trusting an in-memory check: this proves the caller
    // knows the password that the file on disk is actually wrapped with.
    await openVault(readVaultFile(), current);

    assertNotChangedOnDisk();
    const payload = { ...state.payload, writeSeq: state.payload.writeSeq + 1 };
    const { keys, serialized } = await rewrapVault(
      state.keys,
      next,
      Buffer.from(JSON.stringify(payload), 'utf-8'),
    );
    writeAtomic(serialized);
    // The backup is still wrapped with the *old* password and holds every secret. Leaving
    // it would mean the old password never really stopped working.
    fs.rmSync(backupPath(), { force: true });
    lastWriteSeq = payload.writeSeq;
    state = { status: 'unlocked', keys, payload };
  });
}

/**
 * Re-reads and decrypts the file from scratch, without touching the unlocked state — a way
 * to assert what actually landed on disk rather than what is held in memory. Used by the
 * tests; kept because it is the only way to prove a write round-trips.
 */
export function verifyOnDisk(password: string): Promise<VaultPayload> {
  return exclusive(async () => {
    const { keys, plaintext } = await openVault(readVaultFile(), password);
    keys.dek.fill(0);
    try {
      return normalizePayload(JSON.parse(plaintext.toString('utf-8')));
    } finally {
      plaintext.fill(0);
    }
  });
}

/** Read-only view of the decrypted payload. Throws if locked. */
export function read(): VaultPayload {
  if (state.status !== 'unlocked') {
    throw new VaultLockedError();
  }
  return state.payload;
}

/** Applies a mutation and persists it, under the write mutex. */
export function mutate<T>(fn: (payload: VaultPayload) => T): Promise<T> {
  return exclusive(async () => {
    if (state.status !== 'unlocked') throw new VaultLockedError();
    assertNotChangedOnDisk();

    const draft: VaultPayload = {
      ...state.payload,
      connections: [...state.payload.connections],
      aiProviders: [...state.payload.aiProviders],
    };
    const result = fn(draft);
    draft.writeSeq = state.payload.writeSeq + 1;

    writeAtomic(serializeVault(state.keys, Buffer.from(JSON.stringify(draft), 'utf-8')));
    lastWriteSeq = draft.writeSeq;
    state = { status: 'unlocked', keys: state.keys, payload: draft };
    return result;
  });
}

export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked.');
    this.name = 'VaultLockedError';
  }
}

// --- Idle auto-lock -----------------------------------------------------------------

let autoLockMs = 0;
let autoLockTimer: NodeJS.Timeout | null = null;

function stopAutoLockTimer(): void {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
}

export function setAutoLockMinutes(minutes: number): void {
  autoLockMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  if (!autoLockMs) stopAutoLockTimer();
  else if (state.status === 'unlocked') touch();
}

/**
 * Resets the idle countdown. Driven by API activity rather than UI activity: a query that
 * runs for eight minutes is not idleness, and auto-locking mid-flight would close the very
 * driver that is still working.
 */
export function touch(): void {
  if (!autoLockMs || state.status !== 'unlocked') return;
  stopAutoLockTimer();
  autoLockTimer = setTimeout(() => {
    void lock();
  }, autoLockMs);
  autoLockTimer.unref?.();
}
