import { Pool, PoolClient, QueryResult as PgQueryResult } from 'pg';
import { ConnectionConfigWithPassword } from '../connections';
import { Driver, QueryResult, SchemaTree, SchemaNode, TableNode } from './types';

// PostgreSQL built-in type OIDs → human-readable names.
// Covers the types commonly seen in query results; unknown OIDs fall back to "oid:<n>".
const PG_TYPE: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2',
  23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml', 700: 'float4',
  701: 'float8', 790: 'money', 1042: 'bpchar', 1043: 'varchar', 1082: 'date',
  1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval',
  1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
};

export class PostgresDriver implements Driver {
  private pool: Pool;

  constructor(config: ConnectionConfigWithPassword) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database || 'postgres',
      user: config.username,
      password: config.password,
      connectionTimeoutMillis: 10000,
      max: 10,
    });
  }

  async getDatabases(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
    );
    return result.rows.map((r) => r.datname as string);
  }

  async testConnection(): Promise<void> {
    const client = await this.pool.connect();
    client.release();
  }

  async executeQuery(sql: string, onCancel?: (cancel: () => void) => void): Promise<QueryResult> {
    const start = Date.now();
    const client = await this.pool.connect();

    if (onCancel) {
      try {
        const pidResult = await client.query('SELECT pg_backend_pid() AS pid');
        const backendPid = pidResult.rows[0].pid as number;
        onCancel(() => {
          // Cancel from a separate pool connection — sends SIGINT to the backend process,
          // which aborts the current statement and rolls back any uncommitted work.
          this.pool.query('SELECT pg_cancel_backend($1)', [backendPid]).catch(() => {});
        });
      } catch {
        // If PID lookup fails, query runs without cancel support
      }
    }

    try {
      // rowMode 'array' makes pg hand back each row as a positional array instead of
      // an object keyed by column name — the only way to keep duplicate column names
      // (SELECT a.id, b.id ...) as separate values instead of one overwriting the other.
      const queryResult = await client.query({ text: sql, rowMode: 'array' });
      const executionTime = Date.now() - start;
      // When `sql` contains multiple statements (e.g. several queries each ending
      // in ;), pg returns an ARRAY of result objects instead of a single one. Pick
      // the last result that actually produced columns (the last SELECT/RETURNING),
      // falling back to the final statement so DDL/DML-only batches still report a
      // result. This mirrors how SSMS/DBeaver surface the last grid.
      const result: PgQueryResult = Array.isArray(queryResult)
        ? (queryResult as PgQueryResult[]).filter((r) => r.fields && r.fields.length > 0).pop() ??
          queryResult[queryResult.length - 1]
        : queryResult;
      const columns = result.fields ? result.fields.map((f) => f.name) : [];
      const columnTypes = result.fields
        ? result.fields.map((f) => PG_TYPE[f.dataTypeID] ?? `oid:${f.dataTypeID}`)
        : undefined;
      const rows: unknown[][] = (result.rows ?? []).map((row: unknown[]) =>
        row.map((val) => (val instanceof Date ? val.toISOString() : val))
      );
      return {
        columns,
        columnTypes,
        rows,
        rowCount: result.rowCount ?? rows.length,
        executionTime,
      };
    } catch (err) {
      // PostgreSQL error code 57014 = query_canceled (sent by pg_cancel_backend)
      if ((err as { code?: string }).code === '57014') {
        throw new Error('Query cancelled');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getSchemaTree(): Promise<SchemaTree> {
    // Use pool.query() instead of a single PoolClient so that each concurrent
    // query (inside the Promise.all calls below) gets its own connection from
    // the pool. A PoolClient can only execute one query at a time — reusing one
    // across Promise.all branches triggers the pg deprecation warning and will
    // break in pg@9.
    const dbResult = await this.pool.query('SELECT current_database() AS name');
    const dbName = dbResult.rows[0].name as string;

    const schemasResult = await this.pool.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);

    const schemas: SchemaNode[] = await Promise.all(
      schemasResult.rows.map(async (schemaRow) => {
        const schemaName = schemaRow.schema_name as string;

        const tablesResult = await this.pool.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
          [schemaName]
        );

        const tables: TableNode[] = await Promise.all(
          tablesResult.rows.map(async (tableRow) => {
            const tableName = tableRow.table_name as string;

            const columnsResult = await this.pool.query(
              `SELECT column_name, data_type, is_nullable
               FROM information_schema.columns
               WHERE table_schema = $1 AND table_name = $2
               ORDER BY ordinal_position`,
              [schemaName, tableName]
            );

            return {
              name: tableName,
              columns: columnsResult.rows.map((col) => ({
                name: col.column_name as string,
                type: col.data_type as string,
                nullable: col.is_nullable === 'YES',
              })),
            };
          })
        );

        return { name: schemaName, tables };
      })
    );

    return { databases: [{ name: dbName, schemas }] };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
