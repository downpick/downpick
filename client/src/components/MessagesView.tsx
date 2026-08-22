import { QueryResult, StatementSummary } from '../store';
import { formatDuration } from '../formatDuration';

/**
 * What the grid cannot show.
 *
 * Statements that return no result set — UPDATE, DELETE, CREATE INDEX, the DDL half of a
 * batch — used to land on an empty table with nothing but a header strip. Their outcome
 * comes back as one summary per statement, and this lists them in execution order, the way
 * SSMS prints its Messages tab.
 *
 * Deliberately a flat list of lines: server notices (PostgreSQL NOTICE, T-SQL PRINT) are
 * the obvious next thing to show here, and they can be appended without restructuring.
 */
export function MessagesView({ result }: { result: QueryResult }) {
  const statements = result.statements ?? [];

  return (
    <div className="h-full overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed">
      {statements.length === 0 ? (
        <p className="text-text">Commands completed successfully.</p>
      ) : (
        statements.map((statement, i) => (
          <p key={i} className="text-text">
            {describe(statement)}
          </p>
        ))
      )}
      <p className="mt-2 text-text-dim">Completed in {formatDuration(result.executionTime)}</p>
    </div>
  );
}

function rows(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`;
}

/**
 * One statement, one line.
 *
 * SQL Server reports counts without ever naming the statement that produced them, so those
 * lines read as a bare "(5 rows affected)" — which is exactly how SSMS prints them.
 */
function describe({ command, rowsAffected, rowCount }: StatementSummary): string {
  if (rowsAffected != null) {
    const affected = `${rows(rowsAffected)} affected`;
    return command ? `${command} — ${affected}` : `(${affected})`;
  }
  if (rowCount != null) {
    const returned = `${rows(rowCount)} returned`;
    return command ? `${command} — ${returned}` : `(${returned})`;
  }
  return command ? `${command} — completed successfully` : 'Completed successfully.';
}
