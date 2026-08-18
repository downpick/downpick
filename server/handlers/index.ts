import { registerAiHandlers } from './ai';
import { registerAiHistoryHandlers } from './aiHistory';
import { registerConnectionHandlers } from './connections';
import { registerQueryHandlers } from './query';
import { registerSchemaHandlers } from './schema';
import { registerSettingsHandlers } from './settings';
import { registerVaultHandlers } from './vault';

/**
 * Fills the dispatcher's handler table.
 *
 * Registration is explicit rather than a side effect of importing each module, so a test can
 * decide when it happens — and so an import that gets tree-shaken or reordered cannot
 * silently leave a channel unrouted.
 */
export function registerAllHandlers(): void {
  registerVaultHandlers();
  registerConnectionHandlers();
  registerQueryHandlers();
  registerSchemaHandlers();
  registerSettingsHandlers();
  registerAiHandlers();
  registerAiHistoryHandlers();
}
