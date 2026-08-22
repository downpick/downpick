import * as sql from 'mssql';
import { ConnectionConfigWithPassword } from '../connections';
import { Driver, QueryResult, SchemaTree, DatabaseNode, SchemaNode, StatementSummary, TableNode, ColumnNode } from './types';
import { totalRowsAffected } from './statements';

export class SqlServerDriver implements Driver {
  private pool: sql.ConnectionPool | null = null;
  private config: sql.config;

  constructor(cfg: ConnectionConfigWithPassword) {
    this.config = {
      server: cfg.host,
      port: cfg.port,
      database: cfg.database || 'master',
      user: cfg.username,
      password: cfg.password,
      options: {
        trustServerCertificate: true,
        enableArithAbort: true,
        connectTimeout: 10000,
        // mssql defaults requestTimeout to 15s. Disabled here so the app's own
        // configurable query timeout (server/routes/query.ts) is the sole enforcer.
        requestTimeout: 0,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };
  }

  async testConnection(): Promise<void> {
    await this.getPool();
  }

  async getDatabases(): Promise<string[]> {
    const pool = await this.getPool();
    const result = await pool.request().query(
      `SELECT name FROM sys.databases WHERE state = 0 ORDER BY name`
    );
    return result.recordset.map((r: Record<string, unknown>) => r.name as string);
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    // Use a dedicated ConnectionPool per driver instance — NOT the module-global
    // sql.connect(), which returns a single shared pool bound to the first config it
    // ever saw and silently ignores subsequent configs. With the global pool, opening
    // a specific database would keep talking to the server-level (master) connection,
    // so its tables never showed up.
    if (!this.pool) {
      this.pool = new sql.ConnectionPool(this.config);
    }
    // connect() resolves immediately if already connected and queues if a connect
    // is in flight, so it's safe to await unconditionally.
    if (!this.pool.connected) {
      await this.pool.connect();
    }
    return this.pool;
  }

  async executeQuery(sqlText: string, onCancel?: (cancel: () => void) => void): Promise<QueryResult> {
    const start = Date.now();
    const pool = await this.getPool();
    const request = pool.request();
    // Rows come back as positional arrays instead of objects keyed by column name.
    // In the default keyed mode, duplicate column names (SELECT a.id, b.id ...) are
    // merged by mssql into a single array-valued key, so both grid columns showed the
    // same thing. arrayRowMode also moves column metadata to result.columns[recordset].
    request.arrayRowMode = true;

    if (onCancel) {
      // request.cancel() aborts the in-flight statement. mssql rejects the query
      // promise with a cancellation error; nothing is committed.
      onCancel(() => request.cancel());
    }

    let result;
    try {
      result = await request.query(sqlText);
    } catch (err) {
      // mssql sets err.code = 'ECANCEL' when request.cancel() was called.
      if ((err as { code?: string }).code === 'ECANCEL') {
        throw new Error('Query cancelled');
      }
      throw err;
    }
    const executionTime = Date.now() - start;

    const recordset = (result.recordset ?? []) as unknown as unknown[][];

    // With arrayRowMode, column metadata moves to result.columns — one entry per
    // recordset, in statement order. Index 0 matches result.recordset (the first one).
    // @types/mssql doesn't declare this property, hence the cast.
    // Each entry's .type is a constructor whose .name is the SQL type (e.g. "Int", "NVarChar").
    const meta = (result as unknown as { columns?: sql.IColumn[][] }).columns?.[0] ?? [];
    const columns = meta.map((col) => col.name);
    const columnTypes = meta.map(
      (col) => (col.type as { name?: string } | undefined)?.name ?? 'unknown'
    );

    const rows: unknown[][] = recordset.map((row) =>
      row.map((val) => (val instanceof Date ? val.toISOString() : val))
    );

    // mssql reports one entry per statement that produced a count, in statement order, but
    // never the verb that produced it — which is why these lines read as a bare
    // "(N rows affected)", exactly as SSMS prints them.
    const statements: StatementSummary[] = (result.rowsAffected ?? []).map((n) => ({
      rowsAffected: n,
    }));

    return {
      columns,
      columnTypes,
      rows,
      rowCount: rows.length,
      rowsAffected: totalRowsAffected(statements),
      statements,
      executionTime,
    };
  }

  async getSchemaTree(): Promise<SchemaTree> {
    const pool = await this.getPool();

    // Get all databases
    const dbResult = await pool.request().query(`
      SELECT name FROM sys.databases
      WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')
      ORDER BY name
    `);

    // Also include current database
    const currentDbResult = await pool.request().query('SELECT DB_NAME() AS name');
    const currentDb = currentDbResult.recordset[0].name as string;

    let dbNames: string[] = dbResult.recordset.map((r: Record<string, unknown>) => r.name as string);
    if (!dbNames.includes(currentDb)) {
      dbNames = [currentDb, ...dbNames];
    }

    // Only fetch schema for current database to avoid cross-db permission issues
    const schemas = await this.getSchemasForDatabase(pool, currentDb);

    const databases: DatabaseNode[] = [{ name: currentDb, schemas }];

    return { databases };
  }

  private async getSchemasForDatabase(pool: sql.ConnectionPool, dbName: string): Promise<SchemaNode[]> {
    const schemasResult = await pool.request().query(`
      SELECT DISTINCT TABLE_SCHEMA as schema_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY schema_name
    `);

    const schemas: SchemaNode[] = await Promise.all(
      schemasResult.recordset.map(async (schemaRow: Record<string, unknown>) => {
        const schemaName = schemaRow.schema_name as string;

        const tablesResult = await pool
          .request()
          .input('schema', sql.NVarChar, schemaName)
          .query(`
            SELECT TABLE_NAME as table_name
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = @schema AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY table_name
          `);

        const tables: TableNode[] = await Promise.all(
          tablesResult.recordset.map(async (tableRow: Record<string, unknown>) => {
            const tableName = tableRow.table_name as string;

            const columnsResult = await pool
              .request()
              .input('schema', sql.NVarChar, schemaName)
              .input('table', sql.NVarChar, tableName)
              .query(`
                SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
                ORDER BY ORDINAL_POSITION
              `);

            const columns: ColumnNode[] = columnsResult.recordset.map((col: Record<string, unknown>) => ({
              name: col.column_name as string,
              type: col.data_type as string,
              nullable: col.is_nullable === 'YES',
            }));

            return { name: tableName, columns };
          })
        );

        return { name: schemaName, tables };
      })
    );

    return schemas;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }
}
