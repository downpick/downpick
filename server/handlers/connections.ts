import {
  addConnection,
  ConnectionConfigWithPassword,
  DbType,
  deleteConnection,
  findConnection,
  loadConnections,
  loadPassword,
  StoredConnection,
  updateConnection,
} from '../connections';
import {
  ConnectionErrorContext,
  describeConnectionError,
  describeError,
} from '../connectionErrors';
import { AppError, registerHandler } from '../dispatch';
import { createDriver } from '../drivers/registry';
import { Driver } from '../drivers/types';

// Keys: "${connId}" for the server-level driver (default DB, used to list databases)
//       "${connId}::${database}" for database-specific drivers (used for queries + schema)
export const activeConnections = new Map<string, Driver>();

function dbKey(connId: string, database: string): string {
  return `${connId}::${database}`;
}

/** Closes the server-level driver for a connection and every per-database driver under it. */
export async function closeConnectionDrivers(connId: string): Promise<void> {
  for (const key of [...activeConnections.keys()]) {
    if (key !== connId && !key.startsWith(`${connId}::`)) continue;
    await activeConnections.get(key)!.close().catch(() => {});
    activeConnections.delete(key);
  }
}

/**
 * Drops every live driver. Called when the vault locks — otherwise locking would be
 * theatre, with every database still connected and queryable behind a "locked" vault — and
 * again on quit, so the database servers see a clean disconnect rather than a dropped socket.
 */
export async function closeAllConnections(): Promise<void> {
  for (const key of [...activeConnections.keys()]) {
    await activeConnections.get(key)!.close().catch(() => {});
    activeConnections.delete(key);
  }
}

/** Error context without the password, so a stored secret cannot ride along into a message. */
function errorContext(
  connection: StoredConnection,
  extra?: { database?: string; operation?: string },
): ConnectionErrorContext {
  return {
    type: connection.type,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    ...extra,
  };
}

interface ConnectionInput {
  name: string;
  type: DbType;
  host: string;
  port: number;
  username: string;
  password?: string;
}

export function registerConnectionHandlers(): void {
  // Metadata only, never passwords.
  registerHandler('connections:list', () => loadConnections());

  registerHandler('connections:create', async (body: ConnectionInput) => {
    const { name, type, host, port, username, password } = body;
    const id = await addConnection({ name, type, host, port, username, password: password ?? '' });
    return { id };
  });

  // Test an unsaved set of credentials — creates a throwaway driver, connects, closes it.
  // Never touches activeConnections or the saved config, so it's safe to call from the
  // new/edit dialog before the user commits anything.
  registerHandler(
    'connections:test',
    async (body: ConnectionInput & { id?: string }) => {
      const { id, type, host, port, username, password } = body ?? {};
      if (!type || !host || !Number.isFinite(port)) {
        throw new AppError(400, 'Type, host, and port are required.');
      }

      // Editing an existing connection with the password box left blank means "keep the
      // stored password" — test against that one rather than an empty string.
      const effectivePassword = password || (id ? loadPassword(id) : '');
      const config: ConnectionConfigWithPassword = {
        id: id ?? 'test',
        name: 'test',
        type,
        host,
        port,
        username: username ?? '',
        password: effectivePassword,
      };

      let driver: Driver | undefined;
      const started = Date.now();
      try {
        driver = createDriver(type, config);
        await driver.testConnection();
        return { ok: true, elapsedMs: Date.now() - started };
      } catch (err: unknown) {
        // A failed test is an expected outcome, not a transport error — report it as a
        // successful call with `ok: false` so the dialog can render it inline.
        return { ok: false, error: describeConnectionError(err, { type, host, port, username }) };
      } finally {
        await driver?.close().catch(() => {});
      }
    },
  );

  registerHandler('connections:update', async (body: ConnectionInput & { id: string }) => {
    const { id, name, type, host, port, username, password } = body;
    // An absent password means "keep the stored one" — the façade handles that.
    const updated = await updateConnection(id, { name, type, host, port, username }, password);
    if (!updated) throw new AppError(404, 'Connection not found');
    // Config changed — close any open drivers so the next connect uses fresh settings.
    await closeConnectionDrivers(id);
    return { ok: true };
  });

  // Deleting the record deletes the password with it, since the secret lives on the record
  // rather than in a side table.
  registerHandler('connections:delete', async ({ id }: { id: string }) => {
    const removed = await deleteConnection(id);
    if (!removed) throw new AppError(404, 'Connection not found');
    await closeConnectionDrivers(id);
    return { ok: true };
  });

  // Creates/reuses a server-level driver and returns the databases list.
  registerHandler('connections:connect', async ({ id }: { id: string }) => {
    const config = findConnection(id);
    if (!config) throw new AppError(404, 'Connection not found');

    let driver = activeConnections.get(id);
    if (!driver) {
      try {
        driver = createDriver(config.type, config);
        await driver.testConnection();
        activeConnections.set(id, driver);
      } catch (err: unknown) {
        throw new AppError(500, describeConnectionError(err, errorContext(config)));
      }
    }

    try {
      return { databases: await driver.getDatabases() };
    } catch (err: unknown) {
      throw new AppError(
        500,
        describeConnectionError(
          err,
          errorContext(config, {
            operation: `Connected to ${config.host}:${config.port}, but could not list its databases`,
          }),
        ),
      );
    }
  });

  registerHandler('connections:disconnect', async ({ id }: { id: string }) => {
    await closeConnectionDrivers(id);
    return { ok: true };
  });

  // Creates/reuses a DB-specific driver and returns its schema.
  registerHandler(
    'connections:openDb',
    async ({ id, database }: { id: string; database: string }) => {
      if (!activeConnections.has(id)) {
        throw new AppError(400, 'Not connected to server. Connect first.');
      }

      const key = dbKey(id, database);
      let dbDriver = activeConnections.get(key);

      if (!dbDriver) {
        const config = findConnection(id);
        if (!config) throw new AppError(404, 'Connection not found');
        try {
          dbDriver = createDriver(config.type, { ...config, database });
          await dbDriver.testConnection();
          activeConnections.set(key, dbDriver);
        } catch (err: unknown) {
          throw new AppError(
            500,
            describeConnectionError(
              err,
              errorContext(config, {
                database,
                operation: `Could not open database "${database}"`,
              }),
            ),
          );
        }
      }

      try {
        return await dbDriver.getSchemaTree();
      } catch (err: unknown) {
        throw new AppError(
          500,
          `Could not read the schema of "${database}": ${describeError(err)}`,
        );
      }
    },
  );
}
