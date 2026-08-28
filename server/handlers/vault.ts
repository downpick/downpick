import { AppError, registerHandler } from '../dispatch';
import { loadSettings } from '../settings';
import { persistVaultPath, prepareVaultPath } from './settings';
import { VaultCorruptError, VaultFormatError, WrongPasswordError } from '../vault/crypto';
import * as vault from '../vault/store';

// The single key to every database password and API key the app holds. Short enough to be
// typable once a session, long enough that the scrypt cost is not the only thing standing
// between a stolen vault file and its contents.
const MIN_PASSWORD_LENGTH = 12;

// Failed unlocks are not rate-limited beyond this: anyone who can reach this code can also
// copy the file and brute-force it offline, where scrypt is the only real defence. The delay
// exists so the UI cannot be hammered into a spin, not as a security control.
const FAILED_UNLOCK_DELAY_MS = 250;

function vaultError(err: unknown): AppError {
  if (err instanceof WrongPasswordError) return new AppError(401, err.message);
  if (err instanceof VaultCorruptError || err instanceof VaultFormatError) {
    return new AppError(422, err.message);
  }
  return new AppError(400, err instanceof Error ? err.message : 'Vault operation failed.');
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerVaultHandlers(): void {
  registerHandler('vault:status', () => ({
    ...vault.getStatus(),
    path: vault.getVaultPath(),
  }));

  /**
   * Create an empty vault. createVaultFile defaults to emptyPayload(), so there is nothing to
   * seed it with.
   *
   * `vaultFilePath` is how the first-run screen puts the vault somewhere other than the
   * default without going through `settings:update`, which is behind the vault gate and so
   * unreachable before any vault exists. The path is applied before the `isInitialized` check
   * so the 409 speaks about the location the user actually chose, and is only written to
   * settings.json once the file at it exists.
   */
  registerHandler(
    'vault:setup',
    async ({ password, vaultFilePath }: { password?: string; vaultFilePath?: string }) => {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        throw new AppError(
          400,
          `The master password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        );
      }
      const chosen = typeof vaultFilePath === 'string' ? vaultFilePath.trim() : '';
      if (chosen) prepareVaultPath(chosen);

      if (vault.isInitialized()) {
        throw new AppError(409, 'A vault already exists at that path.');
      }
      try {
        await vault.createVaultFile(password);
        persistVaultPath(vault.getVaultPath());
        return { ok: true };
      } catch (err) {
        throw vaultError(err);
      }
    },
  );

  /**
   * `vaultFilePath` lets the unlock screen open a vault the app was not pointed at — a file
   * from a backup or another machine, picked through `files:pickVault`.
   *
   * A failed unlock leaves the candidate path in memory, so the user can retype the password
   * without picking the file again, but leaves settings.json alone: only a vault that actually
   * opened is worth returning to on the next launch.
   */
  registerHandler(
    'vault:unlock',
    async ({ password, vaultFilePath }: { password?: string; vaultFilePath?: string }) => {
      if (typeof password !== 'string' || !password) {
        throw new AppError(400, 'A master password is required.');
      }
      const chosen = typeof vaultFilePath === 'string' ? vaultFilePath.trim() : '';
      if (chosen && chosen !== vault.getVaultPath()) prepareVaultPath(chosen);

      try {
        await vault.unlock(password);
        persistVaultPath(vault.getVaultPath());
        vault.setAutoLockMinutes(loadSettings().autoLockMinutes);
        return { ok: true };
      } catch (err) {
        await delay(FAILED_UNLOCK_DELAY_MS);
        throw vaultError(err);
      }
    },
  );

  registerHandler('vault:lock', async () => {
    await vault.lock();
    return { ok: true };
  });

  registerHandler(
    'vault:changePassword',
    async ({
      currentPassword,
      newPassword,
    }: {
      currentPassword?: string;
      newPassword?: string;
    }) => {
      if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new AppError(
          400,
          `The new master password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        );
      }
      // vault:* is exempt from the dispatcher's gate so the unlock screen can function, so
      // this one has to check for itself.
      if (vault.isLocked()) {
        throw new AppError(423, 'The vault is locked.');
      }
      try {
        await vault.changePassword(currentPassword ?? '', newPassword);
        return { ok: true };
      } catch (err) {
        throw vaultError(err);
      }
    },
  );
}
