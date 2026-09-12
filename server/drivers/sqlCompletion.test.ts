import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlCompletionContext, quoteSqlIdentifier } from './sqlCompletion';
import type { SchemaTree } from './types';
import type { SqlDialect } from './splitSql';

const table = (name: string, ...columns: string[]) => ({
  name, columns: columns.map(name => ({ name, type: 'text', nullable: false })),
});
const schema: SchemaTree = { databases: [{ name: 'db', schemas: [
  { name: 'public', tables: [
    table('orders', 'id', 'total'), table('users', 'id', 'email'), table('a', 'unrelated'),
    table('Odd Table', 'Odd Column'), table('MixedCase', 'Value'),
  ] },
  { name: 'audit', tables: [table('users', 'audit_id', 'changed_at')] },
] }] };

function complete(marked: string, dialect: SqlDialect = 'postgres', catalog = schema) {
  const offset = marked.indexOf('|');
  assert.notEqual(offset, -1);
  return sqlCompletionContext(marked.replace('|', ''), offset, dialect, catalog);
}
const names = (marked: string, dialect: SqlDialect = 'postgres', catalog = schema) =>
  complete(marked, dialect, catalog).columns.map(c => c.name);

test('only the statement at the cursor contributes columns, including its later FROM', () => {
  assert.deepEqual(names('SELECT | FROM orders; SELECT * FROM public.users;'), ['id', 'total']);
  assert.deepEqual(names('SELECT * FROM public.users; SELECT | FROM orders;'), ['id', 'total']);
  assert.deepEqual(names('SELECT x.| FROM orders x; SELECT * FROM public.users x;'), ['id', 'total']);
});

test('completed statements do not leak into a blank statement or a gap', () => {
  for (const sql of ['SELECT * FROM orders; |', 'SELECT * FROM orders;\n|\nSELECT * FROM public.users;', '|']) {
    assert.deepEqual(names(sql), [], sql);
  }
  assert.deepEqual(names('SELECT * FROM orders WHERE |'), ['id', 'total']);
  assert.deepEqual(names('SELECT * FROM orders |;'), ['id', 'total']);
});

test('table identity includes schema and does not guess ambiguous unqualified names', () => {
  assert.deepEqual(names('SELECT u.| FROM public.users u'), ['id', 'email']);
  assert.deepEqual(names('SELECT u.| FROM audit.users u'), ['audit_id', 'changed_at']);
  assert.deepEqual(names('SELECT | FROM public.users'), ['id', 'email']);
  assert.deepEqual(names('SELECT | FROM users'), []);
  assert.deepEqual(names('SELECT public.users.| FROM public.users'), ['id', 'email']);
  assert.deepEqual(names('SELECT audit.users.| FROM public.users'), []);
});

test('aliases beat catalog table names and aliased tables must be addressed by alias', () => {
  assert.deepEqual(names('SELECT a.| FROM orders a'), ['id', 'total']);
  assert.deepEqual(names('SELECT orders.| FROM orders a'), []);
  assert.deepEqual(names('SELECT missing.| FROM orders a'), []);
});

test('joins and comma joins expose visible columns with insertion qualifiers', () => {
  const result = complete('SELECT | FROM orders o JOIN public.users u ON o.id = u.id');
  assert.deepEqual(result.columns.map(c => c.name), ['id', 'total', 'id', 'email']);
  assert.deepEqual(result.columns.filter(c => c.name === 'id').map(c => c.qualifier), [['o'], ['u']]);
  assert.deepEqual(names('SELECT | FROM orders o, public.users u'), ['id', 'total', 'id', 'email']);
  assert.deepEqual(names('SELECT u.| FROM orders o JOIN public.users u ON o.id = u.id'), ['id', 'email']);
});

test('comments and literals cannot introduce tables or aliases', () => {
  for (const sql of [
    'SELECT | FROM orders -- FROM public.users',
    'SELECT | FROM orders /* JOIN public.users */',
    "SELECT 'FROM public.users' AS example, | FROM orders",
    'SELECT $$FROM public.users;$$, | FROM orders',
    "SELECT E'escaped\\\' FROM public.users', | FROM orders",
    'SELECT | FROM orders /* outer /* JOIN public.users */ still comment */',
  ]) assert.deepEqual(names(sql), ['id', 'total'], sql);
});

test('completion is suppressed inside strings and comments, including unfinished ones', () => {
  for (const sql of [
    "SELECT '|text' FROM orders", "SELECT 'text|", 'SELECT /* | */ * FROM orders',
    'SELECT * FROM orders -- |', 'SELECT $$ | $$ FROM orders', 'SELECT /* |',
  ]) assert.equal(complete(sql).suppressed, true, sql);
  assert.equal(complete('SELECT /* comment */ | FROM orders').suppressed, false);
});

test('nested and sibling query scopes do not pollute the outer query', () => {
  assert.deepEqual(names('SELECT | FROM orders o WHERE EXISTS (SELECT 1 FROM public.users u)'), ['id', 'total']);
  assert.deepEqual(names('SELECT count(|) FROM orders o WHERE EXISTS (SELECT 1 FROM public.users u)'), ['id', 'total']);
  assert.deepEqual(names('SELECT * FROM orders x WHERE EXISTS (SELECT x.| FROM public.users x)'), ['id', 'email']);
  assert.deepEqual(names('SELECT * FROM orders o WHERE EXISTS (SELECT o.| FROM public.users u)'), ['id', 'total']);
  assert.deepEqual(names('SELECT 1, (SELECT o.| FROM public.users u) FROM orders o'), ['id', 'total']);
  assert.deepEqual(names('SELECT (SELECT u.| FROM orders o), (SELECT 1 FROM public.users u)'), []);
  assert.deepEqual(names('SELECT * FROM public.users u JOIN (SELECT | FROM orders) o ON true'), ['id', 'total']);
  assert.deepEqual(names('WITH c AS (SELECT | FROM orders) SELECT * FROM public.users'), ['id', 'total']);
  assert.deepEqual(names('WITH c AS MATERIALIZED (SELECT | FROM orders) SELECT * FROM public.users'), ['id', 'total']);
});

test('set operation branches have separate table scopes', () => {
  assert.deepEqual(names('SELECT | FROM orders UNION ALL SELECT * FROM public.users'), ['id', 'total']);
  assert.deepEqual(names('SELECT * FROM public.users UNION ALL SELECT | FROM orders'), ['id', 'total']);
});

test('CTEs and derived tables never borrow columns from same-named physical tables', () => {
  assert.deepEqual(names('WITH orders AS (SELECT * FROM public.users) SELECT o.| FROM orders o'), []);
  assert.deepEqual(names('WITH orders (id) AS (SELECT id FROM public.users) SELECT | FROM orders'), []);
  assert.deepEqual(names('WITH c AS (SELECT * FROM public.users) SELECT | FROM orders AS o'), ['id', 'total']);
  assert.deepEqual(names('SELECT a.| FROM (SELECT * FROM orders) a'), []);
  assert.deepEqual(names('SELECT * FROM orders a WHERE EXISTS (SELECT a.| FROM (SELECT * FROM public.users) a)'), []);
});

test('quoted identifiers preserve spaces and case; unquoted PostgreSQL names fold to lower case', () => {
  assert.deepEqual(names('SELECT "odd alias".| FROM public."Odd Table" AS "odd alias"'), ['Odd Column']);
  assert.deepEqual(names('SELECT | FROM "MixedCase"'), ['Value']);
  assert.deepEqual(names('SELECT | FROM MixedCase'), []);
  assert.deepEqual(names('SELECT O.| FROM ORDERS O'), ['id', 'total']);
  assert.deepEqual(names('SELECT "O".| FROM orders o'), []);
});

test('incomplete and closed quoted column prefixes have an exact replacement range', () => {
  for (const marked of ['SELECT o."to| FROM orders o', 'SELECT o."to|tal" FROM orders o']) {
    const result = complete(marked);
    assert.equal(result.replaceStart, marked.indexOf('"'));
  }
  const result = complete('SELECT o."to|tal" FROM orders o');
  assert.equal(result.replaceEnd, 'SELECT o."total"'.length);
  assert.deepEqual(result.columns.map(c => c.name), ['id', 'total']);
});

test('table context understands schema prefixes and suppresses columns', () => {
  for (const marked of ['SELECT * FROM |', 'SELECT * FROM public.|', 'SELECT * FROM public.us|',
    'SELECT * FROM orders o, |', 'SELECT * FROM orders o, public.|']) {
    const result = complete(marked);
    assert.equal(result.tableContext, true, marked);
    assert.deepEqual(result.columns, []);
    if (result.qualified) assert.ok(result.tables.every(t => t.schema === 'public'));
  }
  assert.deepEqual(complete('SELECT * FROM nonexistent.|').tables, []);
});

test('SQL Server uses bracketed identifiers and GO statement boundaries', () => {
  assert.deepEqual(names('SELECT o.| FROM [public].[orders] o\nGO\nSELECT * FROM [audit].[users] o', 'sqlserver'), ['id', 'total']);
  assert.deepEqual(names('SELECT | FROM [PUBLIC].[USERS]', 'sqlserver'), ['id', 'email']);
  assert.deepEqual(names('SELECT * FROM orders\nGO\n|', 'sqlserver'), []);
  assert.deepEqual(names('SELECT u.| FROM [db].[public].[users] u', 'sqlserver'), ['id', 'email']);
  assert.deepEqual(names('UPDATE o SET o.| FROM orders o', 'sqlserver'), ['id', 'total']);
});

test('Oracle folds unquoted identifiers to upper case and ignores alternative literals', () => {
  const oracle: SchemaTree = { databases: [{ name: 'service', schemas: [{ name: 'APP', tables: [table('ORDERS', 'ID', 'TOTAL')] }] }] };
  assert.deepEqual(names('SELECT o.| FROM app.orders o', 'oracle', oracle), ['ID', 'TOTAL']);
  assert.deepEqual(names("SELECT q'[FROM users;]', | FROM app.orders", 'oracle', oracle), ['ID', 'TOTAL']);
  assert.equal(complete("SELECT q'[|]' FROM app.orders", 'oracle', oracle).suppressed, true);
  assert.deepEqual(names('BEGIN SELECT | FROM app.orders; END;', 'oracle', oracle), []);
});

test('identifier insertion escapes dialect delimiters', () => {
  assert.equal(quoteSqlIdentifier('a"b', 'postgres'), '"a""b"');
  assert.equal(quoteSqlIdentifier('a]b', 'sqlserver'), '[a]]b]');
});

test('PostgreSQL completions leave ordinary column names and qualifiers unquoted', () => {
  for (const name of ['id', 'user_id', 'total', 'public', 'o', '_count', 'value', 'type', 'between', 'ação']) {
    assert.equal(quoteSqlIdentifier(name, 'postgres'), name);
  }
  const columns = complete('SELECT | FROM orders o JOIN public.users u ON o.id = u.id').columns;
  assert.deepEqual(columns.filter(c => c.name === 'id').map(c =>
    [...c.qualifier, c.name].map(n => quoteSqlIdentifier(n, 'postgres')).join('.')), ['o.id', 'u.id']);
});

test('PostgreSQL keeps necessary quotes and honors an explicitly opened quote', () => {
  for (const name of ['MixedCase', 'Odd Column', 'order', 'user', 'authorization', '1st', 'a-b', '']) {
    assert.equal(quoteSqlIdentifier(name, 'postgres'), `"${name}"`);
  }
  assert.equal(quoteSqlIdentifier('id', 'postgres', true), '"id"');
  assert.equal(quoteSqlIdentifier('id', 'sqlserver'), '[id]');
  assert.equal(quoteSqlIdentifier('ID', 'oracle'), '"ID"');
});
