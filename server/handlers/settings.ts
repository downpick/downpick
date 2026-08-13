import * as fs from 'fs';
import * as path from 'path';
import { AppError, registerHandler } from '../dispatch';
import { DEFAULT_VAULT_PATH, loadSettings, saveSettings } from '../settings';
import { parseHeader } from '../vault/crypto';
import * as vault from '../vault/store';

const MAX_QUERY_TIMEOUT_SECONDS = 3600;
const MAX_AUTO_LOCK_MINUTES = 1440;

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
      ...validateVaultFile(settings.vaultFilePath),
    };
  });

  registerHandler(
    'settings:update',
    ({
      vaultFilePath,
      queryTimeoutSeconds,
      autoLockMinutes,
    }: {
      vaultFilePath: string;
      queryTimeoutSeconds?: number;
      autoLockMinutes?: number;
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

      // Ensure the directory can be created if it doesn't exist yet.
      const dir = path.dirname(vaultFilePath);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {
          throw new AppError(400, `Cannot create directory: ${dir}`);
        }
      }

      const current = loadSettings();
      const next = {
        ...current,
        vaultFilePath,
        queryTimeoutSeconds: queryTimeoutSeconds ?? current.queryTimeoutSeconds,
        autoLockMinutes: autoLockMinutes ?? current.autoLockMinutes,
      };
      saveSettings(next);

      // Pointing at a different vault locks the current one — the new file needs its own
      // password, and holding the old file's keys open would be meaningless.
      vault.setVaultPath(vaultFilePath);
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
