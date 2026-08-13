import * as fs from 'fs';
import * as path from 'path';

export const DOWNPICK_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.downpick',
);

export const DEFAULT_VAULT_PATH = path.join(DOWNPICK_DIR, 'vault.enc');

/**
 * Creates the app directory with owner-only permissions, and tightens it if an earlier
 * version of the app left it world-readable. Everything secret this app owns lives here,
 * so 0700 is the floor. chmod is best-effort: it is a no-op on Windows and can fail on
 * network filesystems, neither of which is a reason to refuse to start.
 */
export function ensureSecureDir(dir: string = DOWNPICK_DIR): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Not supported here — the file-level 0600 modes still apply.
  }
  return dir;
}
