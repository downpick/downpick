import { AppError, registerHandler } from '../dispatch';
import { activeConnections } from './connections';

export function registerSchemaHandlers(): void {
  registerHandler('schema:tableIndexes', async (
    { connectionId, database, schema, table }: { connectionId: string; database: string; schema: string; table: string },
  ) => {
    if (typeof schema !== 'string' || !schema || typeof table !== 'string' || !table) {
      throw new AppError(400, 'Invalid schema or table');
    }
    const driver = activeConnections.get(`${connectionId}::${database}`);
    if (!driver) throw new AppError(404, 'No active connection for this database');
    if (!driver.getTableIndexes) throw new AppError(400, 'Indexes are not supported for this database');
    return driver.getTableIndexes(schema, table);
  });

  registerHandler('schema:routineDefinition', async (
    { connectionId, database, routineId }: { connectionId: string; database: string; routineId: string },
  ) => {
    if (typeof routineId !== 'string' || !/^\d+$/.test(routineId)) {
      throw new AppError(400, 'Invalid routine ID');
    }
    const driver = activeConnections.get(`${connectionId}::${database}`);
    if (!driver) throw new AppError(404, 'No active connection for this database');
    if (!driver.getRoutineDefinition) throw new AppError(400, 'Routine scripts are not supported for this database');
    return { script: await driver.getRoutineDefinition(routineId) };
  });

  registerHandler(
    'schema:get',
    async ({ connectionId, database }: { connectionId: string; database: string }) => {
      const driver = activeConnections.get(`${connectionId}::${database}`);
      if (!driver) throw new AppError(404, 'No active connection for this database');

      try {
        return await driver.getSchemaTree();
      } catch (err: unknown) {
        throw new AppError(500, err instanceof Error ? err.message : String(err));
      }
    },
  );
}
