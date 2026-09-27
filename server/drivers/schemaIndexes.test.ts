import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresDriver } from './postgres';
import { SqlServerDriver } from './sqlserver';

// Exercise the complete schema traversal with repeated table names across schemas,
// an unindexed table, and identifiers that must be bound instead of interpolated.
for (const dialect of ['postgres', 'sqlserver'] as const) {
  test(`${dialect} attaches indexes to their own schema/table and retains columns`, async () => {
    const schemas = ['public', "tenant's schema"];
    const calls: unknown[][] = [];
    const catalog = (query: string, params: unknown[] = []): Record<string, unknown>[] => {
      if (/current_database\(\)|DB_NAME\(\)/i.test(query)) return [{ name: 'app' }];
      if (/sys.databases/.test(query)) return [{ name: 'app' }];
      if (/information_schema.schemata|SELECT DISTINCT TABLE_SCHEMA/i.test(query)) {
        return schemas.map((schema_name) => ({ schema_name }));
      }
      if (/information_schema.tables/i.test(query)) {
        assert.ok(schemas.includes(params[0] as string));
        return [{ table_name: "order's" }, { table_name: 'empty' }];
      }
      if (/information_schema.columns/i.test(query)) {
        return [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO' }];
      }
      if (/pg_catalog.pg_index|sys.indexes/.test(query)) {
        assert.equal(params.length, 2);
        calls.push(params);
        assert.ok(!query.includes("tenant's schema"));
        assert.ok(!query.includes("order's"));
        if (dialect === 'postgres') {
          assert.match(query, /ns.nspname = \$1 AND tbl.relname = \$2/);
        } else {
          assert.match(query, /s.name = @schema AND t.name = @table/);
          assert.match(query, /i.index_id > 0 AND i.is_hypothetical = 0/);
        }
        if (params[1] === 'empty') return [];
        return [
          { index_name: `${params[0]}_pk`, index_type: 'BTREE', is_unique: true, is_primary: true,
            creation_script: 'CREATE UNIQUE INDEX "pk" ON "public"."orders" USING btree (id)' },
          { index_name: 'lookup', index_type: 'HASH', is_unique: false, is_primary: false },
          { index_name: 'unique_lookup', index_type: 'BTREE', is_unique: true, is_primary: false },
        ];
      }
      throw new Error(`Unexpected catalog query: ${query}`);
    };

    const driver: PostgresDriver | SqlServerDriver = dialect === 'postgres'
      ? Object.assign(Object.create(PostgresDriver.prototype), {
          pool: { query: async (query: string, params?: unknown[]) => ({ rows: catalog(query, params) }) },
        })
      : Object.assign(Object.create(SqlServerDriver.prototype), {
          pool: {
            connected: true,
            request() {
              const params: unknown[] = [];
              return {
                input(_name: string, _type: unknown, value: unknown) { params.push(value); return this; },
                async query(query: string) { return { recordset: catalog(query, params) }; },
              };
            },
          },
        });

    const tree = await driver.getSchemaTree();
    assert.equal(calls.length, 4);
    assert.equal(tree.databases[0].name, 'app');
    for (const schema of tree.databases[0].schemas) {
      assert.deepEqual(schema.tables[0].columns, [{ name: 'id', type: 'integer', nullable: false }]);
      assert.deepEqual(schema.tables[0].indexes, [
        { name: `${schema.name}_pk`, type: 'BTREE', unique: true, primary: true,
          creationScript: dialect === 'postgres' ? 'CREATE UNIQUE INDEX "pk" ON "public"."orders" USING btree (id);' : undefined },
        { name: 'lookup', type: 'HASH', unique: false, primary: false, creationScript: undefined },
        { name: 'unique_lookup', type: 'BTREE', unique: true, primary: false, creationScript: undefined },
      ]);
      assert.deepEqual(schema.tables[1].indexes, []);
    }
  });
}
