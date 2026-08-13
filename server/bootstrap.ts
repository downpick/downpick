import { cancelAllAiStreams } from './handlers/ai';
import { closeAllConnections } from './handlers/connections';
import { registerAllHandlers } from './handlers';
import { loadSettings } from './settings';
import * as vault from './vault/store';

/**
 * One-time wiring, carried over from the Fastify `buildServer()` this replaced.
 *
 * Must run before the window opens. `setVaultPath` in particular is not optional: without it
 * the store keeps its compiled-in default, so a user who moved their vault elsewhere would be
 * shown the first-run "create a vault" screen pointed at the default path instead of their
 * own file — a failure that is completely invisible on a default-path install.
 */
export function bootstrap(): void {
  registerAllHandlers();

  const settings = loadSettings();
  vault.setVaultPath(settings.vaultFilePath);
  vault.setAutoLockMinutes(settings.autoLockMinutes);
  // Locking has to tear down the live drivers too, or every database stays connected and
  // queryable behind a supposedly locked vault. Wired here to keep the store free of any
  // dependency on the connection handlers.
  vault.setLockHandler(closeAllConnections);
}

/**
 * Releases everything that holds a socket, so the database servers see a clean disconnect
 * rather than a dropped connection they have to time out.
 *
 * Locking is the whole job: the lock handler registered above closes every driver.
 */
export async function shutdown(): Promise<void> {
  cancelAllAiStreams();
  await vault.lock();
  // The vault can already be locked, in which case the handler above did not run.
  await closeAllConnections();
}
