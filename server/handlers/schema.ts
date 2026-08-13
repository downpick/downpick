import { AppError, registerHandler } from '../dispatch';
import { activeConnections } from './connections';

export function registerSchemaHandlers(): void {
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
