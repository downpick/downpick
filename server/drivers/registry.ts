import { ConnectionConfigWithPassword, DbType } from '../connections';
import { Driver, DriverConstructor } from './types';
import { PostgresDriver } from './postgres';
import { SqlServerDriver } from './sqlserver';
import { MongoDriver } from './mongodb';

const DRIVERS: Record<DbType, DriverConstructor> = {
  postgres: PostgresDriver,
  sqlserver: SqlServerDriver,
  mongodb: MongoDriver,
};

export function createDriver(type: DbType, config: ConnectionConfigWithPassword): Driver {
  return new DRIVERS[type](config);
}
