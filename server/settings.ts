import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_VAULT_PATH, DOWNPICK_DIR, ensureSecureDir } from './paths';

const SETTINGS_PATH = path.join(DOWNPICK_DIR, 'settings.json');

export { DEFAULT_VAULT_PATH };

export interface AppSettings {
  /** Encrypted vault holding connections, their passwords, and AI provider keys. */
  vaultFilePath: string;
  // Max seconds a query may run before it's cancelled. 0 means no limit.
  queryTimeoutSeconds: number;
  /** Minutes of API inactivity before the vault re-locks. 0 disables it. */
  autoLockMinutes: number;
  /** Announce a finished query — natively when the window is in the background. */
  notifyOnQueryFinish: boolean;
  /**
   * How long a query must have run to be worth announcing. Queries that come back before this
   * are ones the user watched finish, and a notification for them is only noise.
   */
  notifyAfterSeconds: number;
}

export const DEFAULT_QUERY_TIMEOUT_SECONDS = 30;
export const DEFAULT_AUTO_LOCK_MINUTES = 0;
export const DEFAULT_NOTIFY_ON_QUERY_FINISH = true;
export const DEFAULT_NOTIFY_AFTER_SECONDS = 10;

function ensureDir() {
  ensureSecureDir(DOWNPICK_DIR);
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parseBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function defaults(): AppSettings {
  return {
    vaultFilePath: DEFAULT_VAULT_PATH,
    queryTimeoutSeconds: DEFAULT_QUERY_TIMEOUT_SECONDS,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    notifyOnQueryFinish: DEFAULT_NOTIFY_ON_QUERY_FINISH,
    notifyAfterSeconds: DEFAULT_NOTIFY_AFTER_SECONDS,
  };
}

export function loadSettings(): AppSettings {
  ensureDir();
  if (!fs.existsSync(SETTINGS_PATH)) return defaults();

  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    const str = (value: unknown, fallback: string) =>
      typeof value === 'string' && value.trim() ? value : fallback;

    return {
      vaultFilePath: str(raw?.vaultFilePath, DEFAULT_VAULT_PATH),
      queryTimeoutSeconds: parseNonNegativeInt(raw?.queryTimeoutSeconds, DEFAULT_QUERY_TIMEOUT_SECONDS),
      autoLockMinutes: parseNonNegativeInt(raw?.autoLockMinutes, DEFAULT_AUTO_LOCK_MINUTES),
      notifyOnQueryFinish: parseBool(raw?.notifyOnQueryFinish, DEFAULT_NOTIFY_ON_QUERY_FINISH),
      notifyAfterSeconds: parseNonNegativeInt(raw?.notifyAfterSeconds, DEFAULT_NOTIFY_AFTER_SECONDS),
    };
  } catch {
    return defaults();
  }
}

export function saveSettings(settings: AppSettings): void {
  ensureDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}
