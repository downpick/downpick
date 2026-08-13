import { AppError, registerHandler } from '../dispatch';
import { loadSettings } from '../settings';
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

  // Create an empty vault. createVaultFile defaults to emptyPayload(), so there is nothing
  // to seed it with.
  registerHandler('vault:setup', async ({ password }: { password?: string }) => {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(
        400,
        `The master password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
    if (vault.isInitialized()) {
      throw new AppError(409, 'A vault already exists.');
    }
    try {
      await vault.createVaultFile(password);
      return { ok: true };
    } catch (err) {
      throw vaultError(err);
    }
  });

  registerHandler('vault:unlock', async ({ password }: { password?: string }) => {
    if (typeof password !== 'string' || !password) {
      throw new AppError(400, 'A master password is required.');
    }
    try {
      await vault.unlock(password);
      vault.setAutoLockMinutes(loadSettings().autoLockMinutes);
      return { ok: true };
    } catch (err) {
      await delay(FAILED_UNLOCK_DELAY_MS);
      throw vaultError(err);
    }
  });

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
