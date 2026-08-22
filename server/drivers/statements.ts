import { StatementSummary } from './types';

/**
 * Rows changed across a batch.
 *
 * Returns undefined rather than 0 when no statement reported a count: "0 rows affected"
 * and "this statement doesn't have an affected-row count" are different messages, and only
 * the first one should ever reach the status bar.
 */
export function totalRowsAffected(statements: StatementSummary[]): number | undefined {
  const counted = statements.filter((s) => typeof s.rowsAffected === 'number');
  if (counted.length === 0) return undefined;
  return counted.reduce((sum, s) => sum + (s.rowsAffected ?? 0), 0);
}

/**
 * Reads a MongoDB write's affected-document count out of its acknowledgement.
 *
 * The driver hands write results back as a single acknowledgement document
 * (`{acknowledged, modifiedCount, ...}`) that renders as a one-row grid. That row is worth
 * keeping — it carries the inserted ids — but it is not a count the status bar can read,
 * so the count is lifted out of it here.
 *
 * Reads (find, aggregate, ...) have no affected count; they report rows returned instead.
 */
export function mongoSummary(
  method: string,
  documents: Record<string, unknown>[]
): StatementSummary {
  const ack = documents[0] ?? {};
  const num = (key: string): number => (typeof ack[key] === 'number' ? (ack[key] as number) : 0);

  switch (method) {
    case 'insertOne':
      return { command: method, rowsAffected: ack.insertedId != null ? 1 : 0 };
    case 'insertMany':
      return { command: method, rowsAffected: num('insertedCount') };
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne':
      return { command: method, rowsAffected: num('modifiedCount') + num('upsertedCount') };
    case 'deleteOne':
    case 'deleteMany':
      return { command: method, rowsAffected: num('deletedCount') };
    default:
      return { command: method, rowCount: documents.length };
  }
}
