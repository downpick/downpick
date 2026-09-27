import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresDriver } from './postgres';
import { SqlServerDriver } from './sqlserver';
import { ConnectionConfigWithPassword } from '../connections';

const config = {
  host: 'localhost', port: 5432, database: 'test', username: 'test', password: '',
} as ConnectionConfigWithPassword;

test('PostgreSQL keeps overloaded functions and procedures in a schema without tables', async () => {
  const driver = new PostgresDriver(config);
  const routines = [
    { id: '1', name: 'lookup', kind: 'function', arguments: 'integer' },
    { id: '2', name: 'lookup', kind: 'function', arguments: 'text' },
    { id: '3', name: 'refresh_data', kind: 'procedure', arguments: '' },
  ];
  Object.assign(driver, { pool: { query: async (query: string, values?: string[]) => {
    if (query.includes('current_database()')) return { rows: [{ name: 'test' }] };
    if (query.includes('information_schema.schemata')) return { rows: [{ schema_name: 'routines_only' }] };
    if (query.includes('information_schema.tables')) return { rows: [] };
    assert.ok(query.includes('pg_catalog.pg_proc'));
    assert.deepEqual(values, ['routines_only']);
    return { rows: routines };
  } } });
  const tree = await driver.getSchemaTree();
  assert.deepEqual(tree.databases[0].schemas, [{ name: 'routines_only', tables: [], routines }]);
});

test('SQL Server discovers schemas with only routines and preserves routine kinds', async () => {
  const driver = new SqlServerDriver(config);
  const routines = [
    { id: '10', name: 'lookup', kind: 'function' },
    { id: '11', name: 'refresh_data', kind: 'procedure' },
  ];
  Object.assign(driver, { pool: { connected: true, request: () => {
    const parameters: Record<string, unknown> = {};
    const request = {
      input: (name: string, _type: unknown, value: unknown) => {
        parameters[name] = value;
        return request;
      },
      query: async (query: string) => {
        if (query.includes('sys.databases') || query.includes('DB_NAME()')) return { recordset: [{ name: 'test' }] };
        if (query.includes('SELECT DISTINCT s.name')) {
          for (const type of ['P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT']) assert.ok(query.includes(`'${type}'`));
          return { recordset: [{ schema_name: 'routines_only' }] };
        }
        if (query.includes('INFORMATION_SCHEMA.TABLES')) return { recordset: [] };
        assert.ok(query.includes('sys.objects'));
        assert.equal(parameters.schema, 'routines_only');
        return { recordset: routines };
      },
    };
    return request;
  } } });
  const tree = await driver.getSchemaTree();
  assert.deepEqual(tree.databases[0].schemas, [{ name: 'routines_only', tables: [], routines }]);
});

test('PostgreSQL fetches the selected overload by ID and handles removed routines', async () => {
  const driver = new PostgresDriver(config);
  const script = 'CREATE OR REPLACE FUNCTION public.lookup(integer) RETURNS integer AS $$ SELECT $1 $$ LANGUAGE sql;';
  Object.assign(driver, { pool: { query: async (_query: string, values: string[]) => {
    assert.deepEqual(values, ['2']);
    return { rows: [{ definition: script }] };
  } } });
  assert.equal(await driver.getRoutineDefinition('2'), script);
  Object.assign(driver, { pool: { query: async () => ({ rows: [] }) } });
  await assert.rejects(driver.getRoutineDefinition('2'), /unavailable/);
});

test('SQL Server opens an ALTER script without rewriting comments or the body', async () => {
  const driver = new SqlServerDriver(config);
  let definition: string | null = '';
  Object.assign(driver, { pool: { connected: true, request: () => ({
    input(name: string, _type: unknown, value: string) {
      assert.equal(name, 'id');
      assert.equal(value, '11');
      return this;
    },
    query: async () => ({ recordset: [{ definition }] }),
  }) } });
  for (const header of ['CREATE PROCEDURE', 'CREATE OR ALTER PROC', 'ALTER PROCEDURE', 'create function']) {
    const prefix = '-- CREATE PROCEDURE is an example\n/* metadata */\n';
    const body = " dbo.example AS SELECT 'CREATE PROCEDURE';";
    definition = prefix + header + body;
    assert.equal(await driver.getRoutineDefinition('11'),
      prefix + header.replace(/^create(?: or alter)?/i, 'ALTER') + body);
  }
  definition = null;
  await assert.rejects(driver.getRoutineDefinition('11'), /VIEW DEFINITION/);
});
