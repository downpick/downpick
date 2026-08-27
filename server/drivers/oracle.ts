/**
 * Oracle Database driver — THIN MODE ONLY.
 *
 * `oracledb.initOracleClient()` is never called here and must never be added. Thick mode needs
 * the Oracle Instant Client libraries present on the end user's machine. Downpick ships as a
 * self-contained app to people who have not installed a database client, so the only thing
 * Thick mode would buy is a DPI-1047 at connect time on every machine that happens not to have
 * Instant Client on its library path.
 *
 * What Thin mode costs, recorded so nobody is surprised into "re-enabling" it later:
 *   - Oracle Database 12.1 or newer only. That is also the release ALL_USERS.ORACLE_MAINTAINED
 *     appeared in, so getSchemaTree() below needs no fallback.
 *   - No Oracle Native Network Encryption (SQLNET.ENCRYPTION_SERVER=REQUIRED). TLS works.
 *   - No external/OS/Kerberos authentication, no AQ, no Continuous Query Notification.
 *   - An Oracle Wallet must be PEM, not cwallet.sso.
 * None of those are features this app offers.
 *
 * SECOND RULE, equally load-bearing: nothing in this file writes to the oracledb module object.
 * `oracledb.outFormat`, `.fetchAsString`, `.fetchAsBuffer`, `.autoCommit` and `.fetchArraySize`
 * are all PROCESS-GLOBAL. This process also hosts pg, mssql and mongodb, and hosts one
 * OracleDriver per open connection AND one per open database (see handlers/connections.ts). A
 * global write from one driver's constructor would silently change every other driver's
 * behaviour, last writer wins. Every one of those knobs has a per-execute equivalent, and each
 * is passed explicitly at its call site below.
 */
import oracledbModule from 'oracledb';
import { ConnectionConfigWithPassword } from '../connections';
import { splitSql, SqlStatement } from './splitSql';
import { totalRowsAffected } from './statements';
import {
  ColumnNode,
  Driver,
  QueryResult,
  SchemaNode,
  SchemaTree,
  StatementSummary,
  TableNode,
} from './types';

/**
 * The only oracledb surface this driver may reach.
 *
 * Narrowing at the import site is what makes the Thin-mode rule above structural rather than
 * aspirational: `initOracleClient` is not a member of this alias, so calling it is a compile
 * error, and switching modes means editing this line — where the header comment is — instead of
 * slipping a call into a method three hundred lines down.
 */
const oracledb: Pick<
  typeof oracledbModule,
  | 'createPool'
  | 'OUT_FORMAT_ARRAY'
  | 'STRING'
  | 'BUFFER'
  | 'DB_TYPE_CLOB'
  | 'DB_TYPE_NCLOB'
  | 'DB_TYPE_BLOB'
> = oracledbModule;

/**
 * Pool aliases live in a process-global registry inside oracledb. A unique one per pool makes an
 * alias collision (NJS-046) impossible however many connections and databases the user opens,
 * without depending on close() having run first to free the name.
 */
let poolSeq = 0;

/** Rows beyond this in a RAW column are a BLOB in disguise — see toDisplayValue. */
const INLINE_BYTES = 64;

/**
 * Decides LOB handling per execute rather than through the process-global `fetchAsString` /
 * `fetchAsBuffer` the documentation reaches for first. This is the case the no-globals rule in
 * the header earns its keep on.
 */
function fetchTypeHandler(
  metaData: oracledbModule.Metadata<unknown>,
): oracledbModule.FetchTypeResponse | undefined {
  switch (metaData.dbType) {
    // A CLOB arrives as a readable Lob stream by default. JSON.stringify renders that as {} on
    // the way through dispatch's toWire, and an undrained Lob holds server-side state until the
    // connection closes. STRING makes oracledb drain it for us.
    case oracledb.DB_TYPE_CLOB:
    case oracledb.DB_TYPE_NCLOB:
      return { type: oracledb.STRING };
    // Same problem, but bytes. BLOBs are never rendered as content (see toDisplayValue), so this
    // exists purely to get a plain Buffer rather than a Lob handle.
    case oracledb.DB_TYPE_BLOB:
      return { type: oracledb.BUFFER };
    default:
      return undefined;
  }
}

export function toDisplayValue(value: unknown): unknown {
  // Same Date -> ISO conversion the other two relational drivers do. It is not cosmetic:
  // ResultsGrid's xlsx export sniffs timestamps with /^\d{4}-\d{2}-\d{2}T/, so a value formatted
  // any other way silently stops exporting as a date.
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    // RAW(16) GUIDs and other short RAW columns render as hex — what SQL Developer shows, and
    // what can be pasted back into a query. Anything larger is a BLOB, whose bytes would be
    // JSON-encoded one array element per byte on the way through IPC: megabytes of wire traffic
    // for a cell nobody can read.
    return value.length <= INLINE_BYTES
      ? value.toString('hex').toUpperCase()
      : `<${value.length} bytes>`;
  }
  return value;
}

/**
 * Turns a mid-script failure into a message that says where it stopped and what already ran.
 *
 * The partial StatementSummary[] has nowhere else to go: executeQuery throws, and the query
 * handler turns a throw into an AppError carrying a message and a line, nothing more. Carrying
 * the summaries structurally would mean threading a data field through AppError, the IPC
 * envelope, dispatch, ApiError and the store — a deliberate IPC change, not a side effect of
 * adding a driver.
 */
export function scriptFailure(
  err: unknown,
  part: SqlStatement,
  total: number,
  done: StatementSummary[],
): Error {
  const e = err as { message?: string; offset?: number };
  const detail = (e.message ?? String(err)).trim();
  const affected = totalRowsAffected(done);

  let ran = '';
  if (done.length > 0) {
    const plural = done.length === 1 ? '' : 's';
    const outcome = affected === undefined ? 'completed' : `changed ${affected} row(s)`;
    ran =
      ` The first ${done.length} statement${plural} ran and ${outcome}; ` +
      'nothing after this one was attempted.';
  }

  const out = new Error(
    total > 1 ? `Statement ${done.length + 1} of ${total} failed: ${detail}.${ran}` : detail,
  );

  // Give the failure the property handlers/query.ts already knows how to read. Two corrections,
  // either of which is silently wrong if skipped:
  //   - oracledb's `offset` is ZERO-based; `position` (PostgreSQL's spelling, which errorLine()
  //     was written against) is ONE-based. Hence the +1.
  //   - `offset` is measured against the single statement oracledb was handed, not the script
  //     the user is looking at. splitSql gave us that statement's start. Hence + part.start.
  //     This is the entire reason splitSql returns ranges instead of strings.
  //
  // With no usable offset — ORA-00942 on a missing table is located by the server, not the
  // parser, and reports 0 — the error pins to the first line of the FAILING STATEMENT rather
  // than line 1 of the script. In a forty-statement script that is the difference between a
  // useful marker and a misleading one.
  const offset = typeof e.offset === 'number' && e.offset > 0 ? e.offset : 0;
  (out as Error & { position?: number }).position = part.start + offset + 1;
  return out;
}

export class OracleDriver implements Driver {
  private poolPromise: Promise<oracledbModule.Pool> | null = null;
  private readonly config: ConnectionConfigWithPassword;
  private readonly serviceName: string;

  constructor(config: ConnectionConfigWithPassword) {
    this.config = config;
    // `database` is the node the explorer opened; `serviceName` is what the connection was saved
    // with. For Oracle they hold the same string — getDatabases() returns exactly one entry —
    // but `database` is the one set on the per-database driver, so it wins.
    this.serviceName = config.database || config.serviceName || '';
  }

  private async getPool(): Promise<oracledbModule.Pool> {
    // Memoise the PROMISE, not the pool: getSchemaTree and a query can both arrive before the
    // first createPool resolves, and two concurrent createPool calls would build two pools.
    if (!this.poolPromise) {
      this.poolPromise = oracledb
        .createPool({
          user: this.config.username,
          password: this.config.password,
          // Easy Connect. transport_connect_timeout matches the 10s the other two drivers use;
          // retry_count=0 keeps a dead host from being retried behind the user's back.
          connectString:
            `${this.config.host}:${this.config.port}/${this.serviceName}` +
            '?transport_connect_timeout=10&retry_count=0',
          poolAlias: `downpick-${++poolSeq}`,
          // Same shape as the other two drivers: idle costs nothing, ceiling of 10.
          poolMin: 0,
          poolMax: 10,
          poolIncrement: 1,
          // Retire idle connections so a laptop that sleeps does not wake holding ten sockets
          // the server has already reaped.
          poolTimeout: 60,
          // How long getConnection() waits when all 10 are busy. 10s rather than oracledb's 60s
          // default: with one query per tab, ten busy connections means something is wedged, and
          // a fast clear failure beats a minute of spinner.
          queueTimeout: 10_000,
          stmtCacheSize: 30,
        })
        .catch((err: unknown) => {
          // Do NOT keep a rejected promise: every later call would replay a failure against
          // credentials the user may have fixed in between.
          this.poolPromise = null;
          throw err;
        });
    }
    return this.poolPromise;
  }

  async testConnection(): Promise<void> {
    // createPool() with poolMin: 0 opens nothing, so it succeeds against a wrong password and a
    // wrong service name alike. Actually taking a connection is what makes the dialog's green
    // tick a statement about the server rather than about the shape of the config object.
    const connection = await (await this.getPool()).getConnection();
    await connection.close();
  }

  async getDatabases(): Promise<string[]> {
    // One entry, by design. Oracle's "database" does not line up with the explorer's node: a
    // container's pluggable databases are each reachable only through their own service, which
    // means their own connection, and enumerating them needs CDB_PDBS/V$PDBS — views an ordinary
    // application user cannot read. Returning the service this connection actually points at is
    // the honest answer, and it keeps the openDb key scheme intact.
    return [this.serviceName];
  }

  async executeQuery(sqlText: string, onCancel?: (cancel: () => void) => void): Promise<QueryResult> {
    const start = Date.now();
    const connection = await (await this.getPool()).getConnection();

    let cancelled = false;
    if (onCancel) {
      onCancel(() => {
        // The flag, not the error code, is the primary signal — see the catch below.
        cancelled = true;
        // break() asks the server to abort whatever this connection is running. It is a no-op on
        // an idle connection, so there is no race against the statement finishing first, and it
        // throws once the connection is closed, hence the swallow.
        connection.break().catch(() => {});
      });
    }

    const statements: StatementSummary[] = [];
    let columns: string[] = [];
    let columnTypes: string[] | undefined;
    let rows: unknown[][] = [];

    try {
      // Oracle executes exactly one statement per call, unlike pg and mssql which take a whole
      // batch. Splitting is therefore not an optimisation here, it is the only way a script runs.
      const parts = splitSql(sqlText, 'oracle');
      for (const part of parts) {
        let result: oracledbModule.Result<unknown[]>;
        try {
          // No trailing-semicolon fiddling: splitSql already excludes the `;` from a plain
          // statement (ORA-00911 otherwise) and keeps it on a PL/SQL block (which requires it).
          // That distinction is knowledge the splitter has and this file does not.
          result = await connection.execute<unknown[]>(part.text, [], {
            outFormat: oracledb.OUT_FORMAT_ARRAY,
            // Per statement, and deliberately. A pooled connection.close() ROLLS BACK, so
            // without this a user's UPDATE would report its rowsAffected and then silently
            // vanish when the connection returned to the pool — the worst failure a database
            // client can have. Real manual commit needs a pinned per-tab session, which this
            // app does not have for any engine yet.
            //
            // Consequence, which differs from SQL*Plus's AUTOCOMMIT OFF default and from what
            // SQL Developer and Toad do: a five-statement script is FIVE transactions. A failure
            // at statement three leaves one and two committed, and there is no rollback.
            autoCommit: true,
            fetchTypeHandler,
            fetchArraySize: 1000,
          });
        } catch (err) {
          if (cancelled) throw new Error('Query cancelled');
          throw scriptFailure(err, part, parts.length, statements);
        }

        statements.push({
          command: part.verb || undefined,
          // oracledb sets rowsAffected for DML only — undefined for SELECT and for PL/SQL, which
          // is exactly the distinction StatementSummary documents.
          rowsAffected: result.rowsAffected,
          rowCount: result.metaData ? (result.rows?.length ?? 0) : undefined,
        });

        if (result.metaData) {
          // The last statement that produced columns wins the grid — the same rule postgres.ts
          // applies when pg hands back an array of results for a batch.
          columns = result.metaData.map((m) => m.name);
          // No hand-maintained type table here, unlike PG_TYPE in postgres.ts: oracledb reports
          // the type name itself, already in the spelling an Oracle user would write.
          columnTypes = result.metaData.map((m) => m.dbTypeName ?? 'unknown');
          rows = (result.rows ?? []).map((row) => row.map(toDisplayValue));
        }
      }

      return {
        columns,
        columnTypes,
        rows,
        rowCount: rows.length,
        rowsAffected: totalRowsAffected(statements),
        statements,
        executionTime: Date.now() - start,
      };
    } finally {
      // A connection broken out of a statement must NOT go back into the pool for reuse: after
      // an out-of-band break its server-side state is not guaranteed, and the next query to draw
      // it would fail for reasons that have nothing to do with that query. drop:true retires it.
      await connection.close({ drop: cancelled }).catch(() => {});
    }
  }

  async getSchemaTree(): Promise<SchemaTree> {
    // Three executes on one connection — NOT the one-query-per-table pattern postgres.ts and
    // sqlserver.ts use. On an instance with a few thousand tables that pattern is a few thousand
    // round trips against ALL_TAB_COLUMNS, one of the heaviest dictionary views there is.
    const connection = await (await this.getPool()).getConnection();
    try {
      const opts = {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        // The column query returns tens of thousands of rows on a real instance. oracledb's
        // default fetchArraySize is 100; 1000 cuts the round trips by an order of magnitude and
        // is the single setting that decides whether the tree loads in a second or in thirty.
        fetchArraySize: 1000,
      } as const;

      // ORACLE_MAINTAINED = 'N' excludes SYS, SYSTEM, XDB, APEX_* and the ~35 other accounts
      // Oracle creates for itself, the same way postgres.ts excludes pg_catalog. It exists from
      // 12.1 onward, which is also Thin mode's minimum server version — no fallback needed.
      const users = await connection.execute<[string]>(
        `SELECT username
           FROM all_users
          WHERE oracle_maintained = 'N'
          ORDER BY username`,
        [],
        opts,
      );

      const tables = await connection.execute<[string, string]>(
        `SELECT t.owner, t.table_name
           FROM all_tables t
           JOIN all_users u ON u.username = t.owner
          WHERE u.oracle_maintained = 'N'
          ORDER BY t.owner, t.table_name`,
        [],
        opts,
      );

      // Every column of every visible non-Oracle schema, in one statement.
      //
      // Deliberately NOT joined to all_tables: that join reads a second heavy dictionary view to
      // perform a filter the in-memory grouping below already does for free. A column whose
      // (owner, table) has no table node — a view's column, or a table the user can see columns
      // of but not the table itself — simply finds nowhere to attach and is dropped.
      const columns = await connection.execute<[string, string, string, string, string]>(
        `SELECT c.owner, c.table_name, c.column_name, c.data_type, c.nullable
           FROM all_tab_columns c
           JOIN all_users u ON u.username = c.owner
          WHERE u.oracle_maintained = 'N'
          ORDER BY c.owner, c.table_name, c.column_id`,
        [],
        opts,
      );

      const bySchema = new Map<string, Map<string, ColumnNode[]>>();
      // Seeded from all_users rather than from all_tables, so a schema the user can see but
      // whose tables they cannot read still appears as an empty node. "This schema exists and
      // you have no access to its tables" is a normal Oracle situation and worth seeing;
      // silently omitting it looks like the schema is gone.
      for (const [username] of users.rows ?? []) bySchema.set(username, new Map());
      for (const [owner, table] of tables.rows ?? []) bySchema.get(owner)?.set(table, []);
      for (const [owner, table, name, type, nullable] of columns.rows ?? []) {
        bySchema.get(owner)?.get(table)?.push({ name, type, nullable: nullable === 'Y' });
      }

      const own = (this.config.username || '').toUpperCase();
      const schemas: SchemaNode[] = [...bySchema.entries()]
        .map(([name, tableMap]) => ({
          name,
          tables: [...tableMap.entries()].map(
            ([table, cols]): TableNode => ({ name: table, columns: cols }),
          ),
        }))
        // The connecting user's own schema first: on an instance with two hundred application
        // schemas, theirs is the one they came for.
        .sort((a, b) => {
          const rank = (n: string) => (n === own ? 0 : 1);
          return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
        });

      return { databases: [{ name: this.serviceName, schemas }] };
    } finally {
      await connection.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const pending = this.poolPromise;
    this.poolPromise = null;
    if (!pending) return;
    // A rejected createPool is not a pool to close.
    const pool = await pending.catch(() => null);
    // Always close(0). pool.close() with no drain time raises NJS-104 while connections are
    // still checked out, and the two callers are the vault locking and the app quitting — both
    // of which want the sockets gone now. A query still running is precisely what locking the
    // vault is meant to stop.
    await pool?.close(0).catch(() => {});
  }
}
