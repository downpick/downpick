import { api } from './api';
import { Tab, useStore } from './store';

/**
 * Announce a finished query, wherever the user happens to be looking.
 *
 * The decision is main's, not this function's: it owns the "was this long enough to be worth
 * announcing" threshold and it is the only side that can tell whether the window is actually
 * in front of the user. All that comes back is whether the renderer still owes a toast.
 *
 * Never rejects. A notification that could not be delivered is not a query that failed, and
 * the caller runs inside the run path — letting this throw would turn a successful query into
 * an error in the results pane.
 */
export async function notifyQueryFinished(
  tab: Pick<Tab, 'id' | 'connectionName' | 'database'>,
  outcome: 'success' | 'timeout',
  elapsedMs: number,
  detail: string,
): Promise<void> {
  try {
    const { shown } = await api.notifyQueryFinished({
      tabId: tab.id,
      outcome,
      connectionName: tab.connectionName,
      database: tab.database,
      elapsedMs,
      detail,
    });
    if (shown !== 'toast') return;

    useStore.getState().pushToast({
      kind: outcome === 'timeout' ? 'warning' : 'info',
      title: outcome === 'timeout' ? 'Query timed out' : 'Query finished',
      body: `${tab.connectionName} · ${tab.database} — ${detail}`,
      tabId: tab.id,
    });
  } catch {
    // Nothing to recover: the query itself already reported its own outcome.
  }
}
