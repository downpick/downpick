import * as fs from 'fs';
import * as path from 'path';
import { AppError, registerHandler } from '../dispatch';
import { DEFAULT_VAULT_PATH, loadSettings, saveSettings } from '../settings';
import { parseHeader } from '../vault/crypto';
import * as vault from '../vault/store';

const MAX_QUERY_TIMEOUT_SECONDS = 3600;
const MAX_AUTO_LOCK_MINUTES = 1440;
const MAX_NOTIFY_AFTER_SECONDS = 3600;

export interface ValidationResult {
  fileExists: boolean;
  valid: boolean;
  error?: string;
}

/**
 * Checks that a path holds a vault this build can open — a well-formed envelope with a
 * supported version and in-policy KDF parameters. It cannot say anything about the
 * contents: that needs the master password.
 *
 * A missing file is valid; it will be created by the setup flow.
 */
export function validateVaultFile(filePath: string): ValidationResult {
  if (!fs.existsSync(filePath)) {
    return { fileExists: false, valid: true };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { fileExists: true, valid: false, error: 'Cannot read file (permission denied?)' };
  }

  try {
    const envelope = JSON.parse(raw) as { header?: string };
    parseHeader(envelope?.header ?? '');
    return { fileExists: true, valid: true };
  } catch (err) {
    return {
      fileExists: true,
      valid: false,
      error: err instanceof Error ? err.message : 'The file is not a Downpick vault',
    };
  }
}

/**
 * Points the vault at `filePath`, creating its directory if it does not exist yet.
 *
 * In-memory only: `vault.setVaultPath` locks whatever was open, because the file at the new
 * path has its own password and holding the old file's keys would be meaningless. Nothing is
 * written to settings.json — see `persistVaultPath` for why those are two steps.
 */
export function prepareVaultPath(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new AppError(400, `Cannot create directory: ${dir}`);
    }
  }
  vault.setVaultPath(filePath);
}

/**
 * Remembers `filePath` as the vault to open on the next launch.
 *
 * Called only once a vault at that path has actually been created or unlocked. A path that
 * turned out to be a wrong pick — an unreadable file, a mistyped location — therefore never
 * survives a restart, which is what stops a bad choice from stranding the user on an unlock
 * screen for a file they cannot open.
 */
export function persistVaultPath(filePath: string): void {
  const current = loadSettings();
  if (current.vaultFilePath === filePath) return;
  saveSettings({ ...current, vaultFilePath: filePath });
}

export function registerSettingsHandlers(): void {
  // Readable while the vault is locked, because the shell needs it to render the unlock
  // screen. Nothing here is secret: paths and timeouts only.
  registerHandler('settings:get', () => {
    const settings = loadSettings();
    return {
      vaultFilePath: settings.vaultFilePath,
      defaultVaultPath: DEFAULT_VAULT_PATH,
      queryTimeoutSeconds: settings.queryTimeoutSeconds,
      autoLockMinutes: settings.autoLockMinutes,
      notifyOnQueryFinish: settings.notifyOnQueryFinish,
      notifyAfterSeconds: settings.notifyAfterSeconds,
      ...validateVaultFile(settings.vaultFilePath),
    };
  });

  registerHandler(
    'settings:update',
    ({
      vaultFilePath,
      queryTimeoutSeconds,
      autoLockMinutes,
      notifyOnQueryFinish,
      notifyAfterSeconds,
    }: {
      vaultFilePath: string;
      queryTimeoutSeconds?: number;
      autoLockMinutes?: number;
      notifyOnQueryFinish?: boolean;
      notifyAfterSeconds?: number;
    }) => {
      if (!vaultFilePath?.trim()) {
        throw new AppError(400, 'vaultFilePath is required');
      }
      if (
        queryTimeoutSeconds != null &&
        (!Number.isFinite(queryTimeoutSeconds) ||
          queryTimeoutSeconds < 0 ||
          queryTimeoutSeconds > MAX_QUERY_TIMEOUT_SECONDS)
      ) {
        throw new AppError(
          400,
          `queryTimeoutSeconds must be between 0 and ${MAX_QUERY_TIMEOUT_SECONDS}`,
        );
      }
      if (
        autoLockMinutes != null &&
        (!Number.isFinite(autoLockMinutes) ||
          autoLockMinutes < 0 ||
          autoLockMinutes > MAX_AUTO_LOCK_MINUTES)
      ) {
        throw new AppError(400, `autoLockMinutes must be between 0 and ${MAX_AUTO_LOCK_MINUTES}`);
      }
      if (notifyOnQueryFinish != null && typeof notifyOnQueryFinish !== 'boolean') {
        throw new AppError(400, 'notifyOnQueryFinish must be a boolean');
      }
      if (
        notifyAfterSeconds != null &&
        (!Number.isFinite(notifyAfterSeconds) ||
          notifyAfterSeconds < 0 ||
          notifyAfterSeconds > MAX_NOTIFY_AFTER_SECONDS)
      ) {
        throw new AppError(
          400,
          `notifyAfterSeconds must be between 0 and ${MAX_NOTIFY_AFTER_SECONDS}`,
        );
      }

      const current = loadSettings();
      const next = {
        ...current,
        vaultFilePath,
        queryTimeoutSeconds: queryTimeoutSeconds ?? current.queryTimeoutSeconds,
        autoLockMinutes: autoLockMinutes ?? current.autoLockMinutes,
        notifyOnQueryFinish: notifyOnQueryFinish ?? current.notifyOnQueryFinish,
        notifyAfterSeconds: notifyAfterSeconds ?? current.notifyAfterSeconds,
      };
      saveSettings(next);

      // Unlike the first-run flow, this one persists the path up front: the user is here with
      // the vault already open and is stating where it should live from now on, rather than
      // guessing at a file they have yet to prove they can read.
      prepareVaultPath(vaultFilePath);
      vault.setAutoLockMinutes(next.autoLockMinutes);

      return { ok: true, ...validateVaultFile(vaultFilePath) };
    },
  );

  // Validate a candidate path without saving. Behind the vault gate, so it is not reachable
  // as a filesystem oracle before the vault is open.
  registerHandler('settings:validate', ({ path: filePath }: { path: string }) => {
    if (!filePath?.trim()) throw new AppError(400, 'path is required');
    return validateVaultFile(filePath);
  });
}
