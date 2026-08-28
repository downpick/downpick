import { ConnectionConfigWithPassword, DbType } from '../connections';
import { Driver, DriverConstructor } from './types';
import { PostgresDriver } from './postgres';
import { SqlServerDriver } from './sqlserver';
import { MongoDriver } from './mongodb';
import { OracleDriver } from './oracle';

const DRIVERS: Record<DbType, DriverConstructor> = {
  postgres: PostgresDriver,
  sqlserver: SqlServerDriver,
  mongodb: MongoDriver,
  oracle: OracleDriver,
};

export function createDriver(type: DbType, config: ConnectionConfigWithPassword): Driver {
  return new DRIVERS[type](config);
}
