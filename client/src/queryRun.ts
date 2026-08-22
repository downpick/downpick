import { api } from './api';
import { useStore } from './store';

/**
 * Ask the server to cancel a tab's in-flight query.
 *
 * The query id lives on the tab rather than in the editor, so both places that can stop a
 * query — the editor's Stop button and the Cancel button in the running results pane —
 * reach it the same way. The query promise then rejects with "Query cancelled" and lands in
 * setTabError; nothing is committed.
 */
export async function cancelTabQuery(tabId: string): Promise<void> {
  const queryId = useStore.getState().tabs.find((t) => t.id === tabId)?.runQueryId;
  if (!queryId) return;
  try {
    await api.cancelQuery(queryId);
  } catch {
    // Query may have just finished; ignore.
  }
}
