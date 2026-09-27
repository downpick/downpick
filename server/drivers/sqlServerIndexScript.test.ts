import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sqlServerIndexScript } from './sqlServerIndexScript';

const index = {
  index_name: 'lookup]', type_id: 2, is_unique: true,
  index_columns: JSON.stringify([
    { name: 'second]', key_ordinal: 2, is_descending_key: true, is_included_column: false },
    { name: 'payload', key_ordinal: 0, is_descending_key: false, is_included_column: true },
    { name: 'first', key_ordinal: 1, is_descending_key: false, is_included_column: false },
    { name: 'implicit_partition', key_ordinal: 0, is_descending_key: false, is_included_column: false },
  ]),
  has_filter: true, filter_definition: '([first] IS NOT NULL)',
};

test('scripts composite keys in ordinal order, included columns, filters and escaped names', () => {
  const script = sqlServerIndexScript('tenant]', "order's", index)!;
  assert.ok(script.endsWith(
    "CREATE UNIQUE NONCLUSTERED INDEX [lookup]]]\nON [tenant]]].[order's] ([first] ASC, [second]]] DESC)\nINCLUDE ([payload])\nWHERE ([first] IS NOT NULL);",
  ));
  assert.doesNotMatch(script, /implicit_partition/);
});

test('constraint-backed indexes recreate the constraint with its own name', () => {
  for (const primary of [true, false]) {
    const script = sqlServerIndexScript('dbo', 'orders', {
      ...index, type_id: 1, is_primary: primary, constraint_name: 'constraint]', has_filter: false,
    })!;
    assert.ok(script.endsWith(
      `ALTER TABLE [dbo].[orders]\nADD CONSTRAINT [constraint]]] ${primary ? 'PRIMARY KEY' : 'UNIQUE'} CLUSTERED ([first] ASC, [second]]] DESC);`,
    ));
    assert.doesNotMatch(script, /CREATE|INCLUDE|WHERE/);
  }
});

test('ordinary nonunique indexes omit UNIQUE and WHERE', () => {
  const script = sqlServerIndexScript('dbo', 'orders', { ...index, is_unique: false, has_filter: false })!;
  assert.match(script, /CREATE NONCLUSTERED INDEX/);
  assert.doesNotMatch(script, /UNIQUE|WHERE/);
});

test('does not invent DDL for special index types or inaccessible metadata', () => {
  for (const override of [
    { type_id: 3 }, { type_id: 4 }, { type_id: 5 }, { type_id: 6 }, { type_id: 7 },
    { is_memory_optimized: true }, { filter_definition: null }, { index_columns: '[]' },
  ]) {
    assert.equal(sqlServerIndexScript('dbo', 'orders', { ...index, ...override }), undefined);
  }
});
