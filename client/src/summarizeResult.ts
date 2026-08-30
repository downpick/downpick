import { formatDuration } from './formatDuration';
import type { QueryResult } from './store';

/**
 * The one-line verdict on a finished run.
 *
 * "rows" and "rows affected" are different facts that used to print as the same one: an
 * UPDATE read "5 rows" above an empty grid on PostgreSQL, and "0 rows" on SQL Server.
 *
 * Shared rather than private to the status bar, because a finished-query notification says
 * the same thing about the same run — and two copies of this would drift the first time
 * either wording changed.
 */
export function summarizeResult(result: QueryResult): string {
  const time = formatDuration(result.executionTime);
  if (result.columns.length > 0) return `${result.rowCount} rows · ${time}`;
  if (result.rowsAffected != null) {
    const rows = result.rowsAffected === 1 ? 'row' : 'rows';
    return `${result.rowsAffected} ${rows} affected · ${time}`;
  }
  return `Completed · ${time}`;
}
