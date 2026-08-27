import { AppError, registerHandler } from '../dispatch';
import { loadSettings } from '../settings';
import { activeConnections } from './connections';

// Maps a client-supplied queryId → cancel function for in-flight queries.
// Populated when a query starts, removed when it finishes (success, error, or cancel).
const runningQueries = new Map<string, () => void>();

// Derives the 1-based line number of a query error from the driver's error metadata.
// PostgreSQL reports `position` (a 1-based character offset into the submitted SQL);
// SQL Server reports `lineNumber` (a 1-based line within the batch) directly.
export function errorLine(sql: string, err: unknown): number | undefined {
  const e = err as { position?: string | number; lineNumber?: number };
  if (e.position != null) {
    const pos = typeof e.position === 'string' ? parseInt(e.position, 10) : e.position;
    if (Number.isFinite(pos) && pos > 0) {
      // Count the newlines preceding the offending character.
      return sql.slice(0, pos - 1).split('\n').length;
    }
  }
  if (typeof e.lineNumber === 'number' && e.lineNumber > 0) {
    return e.lineNumber;
  }
  return undefined;
}

const ROW_LIMIT = 10_000;

export function registerQueryHandlers(): void {
  registerHandler(
    'query:run',
    async ({
      connectionId,
      database,
      sql,
      queryId,
    }: {
      connectionId: string;
      database: string;
      sql: string;
      queryId?: string;
    }) => {
      if (!connectionId || !database || !sql?.trim()) {
        throw new AppError(400, 'connectionId, database, and sql are required');
      }

      const driver = activeConnections.get(`${connectionId}::${database}`);
      if (!driver) {
        throw new AppError(
          404,
          'No active connection for this database. Open it from the explorer first.',
        );
      }

      const { queryTimeoutSeconds } = loadSettings();
      let timedOut = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await driver.executeQuery(sql, (cancel) => {
          if (queryId) runningQueries.set(queryId, cancel);
          // Reuse the same cancel path as manual "Cancel query" — the driver aborts
          // the in-flight statement server-side, same as a user-initiated cancel.
          if (queryTimeoutSeconds > 0) {
            timeoutTimer = setTimeout(() => {
              timedOut = true;
              cancel();
            }, queryTimeoutSeconds * 1000);
          }
        });
        if (result.rows.length > ROW_LIMIT) {
          return {
            ...result,
            rows: result.rows.slice(0, ROW_LIMIT),
            documents: result.documents?.slice(0, ROW_LIMIT),
            truncated: true,
          };
        }
        return result;
      } catch (err: unknown) {
        if (timedOut) {
          throw new AppError(400, `Query timed out after ${queryTimeoutSeconds}s`);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new AppError(400, message, errorLine(sql, err));
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (queryId) runningQueries.delete(queryId);
      }
    },
  );

  // Cancel an in-flight query by its queryId. The driver aborts the statement; because each
  // query runs in its own implicit transaction, nothing is committed.
  registerHandler('query:cancel', ({ queryId }: { queryId: string }) => {
    const cancel = runningQueries.get(queryId);
    if (!cancel) throw new AppError(404, 'No running query with that id');
    cancel();
    return { ok: true };
  });
}
