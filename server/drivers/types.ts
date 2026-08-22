import { ConnectionConfigWithPassword } from '../connections';

/**
 * One statement's outcome, in execution order.
 *
 * A batch (`UPDATE ...; SELECT ...;`) produces one entry per statement, which is what the
 * Messages view lists. The grid still shows a single result set — the summaries are how
 * everything the grid cannot show (DDL, DML, the other statements in a batch) reports back.
 */
export interface StatementSummary {
  /** Driver-supplied verb ('UPDATE', 'CREATE', 'insertMany'). SQL Server exposes none. */
  command?: string;
  /** Rows the statement changed. Undefined for statements that report no count. */
  rowsAffected?: number;
  /** Rows returned, when the statement produced a result set. */
  rowCount?: number;
}

export interface QueryResult {
  columns: string[];
  columnTypes?: string[];
  // Positional: rows[i][n] is the value of columns[n]. NOT keyed by column name —
  // a query can legitimately return two columns with the same name (e.g.
  // SELECT a.id, b.id FROM a JOIN b), and a name-keyed object collapses them into a
  // single value that the grid would then repeat under both headers.
  rows: unknown[][];
  /** Rows returned in `rows` — never an affected-row count, which lives in `rowsAffected`. */
  rowCount: number;
  /** Rows changed across every statement in the batch. Undefined when none reported one. */
  rowsAffected?: number;
  /** One entry per statement the driver reported on. Drives the Messages view. */
  statements?: StatementSummary[];
  executionTime: number;
  // Raw (non-flattened) documents, populated by document-oriented drivers (MongoDB) so the
  // client can offer an expandable per-document view alongside the flattened table view.
  documents?: Record<string, unknown>[];
}

export interface SchemaTree {
  databases: DatabaseNode[];
}

export interface DatabaseNode {
  name: string;
  schemas: SchemaNode[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
}

export interface TableNode {
  name: string;
  columns: ColumnNode[];
}

export interface ColumnNode {
  name: string;
  type: string;
  nullable: boolean;
}

export interface Driver {
  testConnection(): Promise<void>;
  getDatabases(): Promise<string[]>;
  executeQuery(sql: string, onCancel?: (cancel: () => void) => void): Promise<QueryResult>;
  getSchemaTree(): Promise<SchemaTree>;
  close(): Promise<void>;
  /**
   * Infers field names and types by sampling documents, for stores that declare no schema.
   *
   * Only document databases implement this: `getSchemaTree()` returns MongoDB collections
   * with an empty `columns` array because there is nothing to read them from, which leaves
   * anything that needs field names — the AI assistant, most obviously — with nothing to
   * work from. Relational drivers omit it; their catalogs already carry the columns.
   *
   * Returns names and types only. The sampled values never leave this method.
   */
  inferFields?(table: string, sampleSize: number): Promise<ColumnNode[]>;
}

export interface DriverConstructor {
  new (config: ConnectionConfigWithPassword): Driver;
}
