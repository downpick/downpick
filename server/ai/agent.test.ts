import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuery, runAgent } from './agent';
import { AiRequestError, resolveBaseUrl } from './net';
import { createSchemaToolset, MAX_EDITOR_CHARS } from './tools';
import { ChatAdapter, CompletionRequest, CompletionResult } from './types';
import { Driver, SchemaTree } from '../drivers/types';

const TREE: SchemaTree = {
  databases: [
    {
      name: 'analytics',
      schemas: [
        {
          name: 'public',
          tables: [
            {
              name: 'orders',
              columns: [
                { name: 'id', type: 'uuid', nullable: false },
                { name: 'total', type: 'numeric', nullable: true },
              ],
            },
            {
              name: 'users',
              columns: [{ name: 'email', type: 'text', nullable: false }],
            },
          ],
        },
      ],
    },
  ],
};

/** A driver whose executeQuery fails the test if the agent ever reaches for it. */
function stubDriver(overrides: Partial<Driver> = {}): Driver & { schemaReads: number } {
  const driver = {
    schemaReads: 0,
    async testConnection() {},
    async getDatabases() {
      return ['analytics'];
    },
    async executeQuery(): Promise<never> {
      throw new Error('the assistant must never execute a query');
    },
    async getSchemaTree() {
      driver.schemaReads++;
      return TREE;
    },
    async close() {},
    ...overrides,
  };
  return driver as Driver & { schemaReads: number };
}

/** Replays a scripted list of completions, one per call. */
function scriptedAdapter(script: CompletionResult[]): ChatAdapter & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    async complete(req: CompletionRequest) {
      calls.push(req);
      return script[Math.min(calls.length - 1, script.length - 1)];
    },
    async listModels() {
      return [];
    },
  };
}

function baseRequest(adapter: ChatAdapter, driver: Driver) {
  return {
    adapter,
    apiKey: 'test-key',
    model: 'test-model',
    dbType: 'postgres' as const,
    database: 'analytics',
    toolset: createSchemaToolset(driver, 'postgres', 'analytics'),
    history: [],
    question: 'top orders please',
    onStep: () => {},
  };
}

test('runs the tools, streams their trace, and never executes a query', async () => {
  const driver = stubDriver();
  const adapter = scriptedAdapter([
    {
      text: '',
      toolCalls: [
        { id: 'c1', name: 'list_tables', args: {} },
        { id: 'c2', name: 'describe_tables', args: { tables: ['orders'] } },
      ],
    },
    { text: 'Sorted by total.\n\n```sql\nSELECT * FROM "public"."orders";\n```', toolCalls: [] },
  ]);

  const steps: string[] = [];
  const reply = await runAgent({
    ...baseRequest(adapter, driver),
    onStep: (step) => steps.push(step.label),
  });

  assert.deepEqual(steps, [
    'Listing tables in analytics',
    'Reading columns for orders',
  ]);
  assert.equal(reply.sql, 'SELECT * FROM "public"."orders";');
  assert.equal(reply.note, 'Sorted by total.');
  assert.deepEqual(
    reply.trace.map((t) => t.label),
    steps,
  );

  // The tool results were fed back before the second call.
  const second = adapter.calls[1];
  assert.equal(second.transcript.at(-1)?.role, 'tool');
  // The catalog is read once per turn, not once per tool call.
  assert.equal(driver.schemaReads, 1);
});

test('reports a real column list rather than the model guessing', async () => {
  const driver = stubDriver();
  const toolset = createSchemaToolset(driver, 'postgres', 'analytics');
  const outcome = await toolset.run({
    id: 'c1',
    name: 'describe_tables',
    args: { tables: ['public.orders'] },
  });
  assert.match(outcome.content, /public\.orders:/);
  assert.match(outcome.content, /id uuid NOT NULL/);
  assert.match(outcome.content, /total numeric/);
});

test('tells the model when a table does not exist instead of inventing one', async () => {
  const toolset = createSchemaToolset(stubDriver(), 'postgres', 'analytics');
  const outcome = await toolset.run({
    id: 'c1',
    name: 'describe_tables',
    args: { tables: ['invoices'] },
  });
  assert.match(outcome.content, /no such table/);
});

test('offers a schema tool to relational engines and withholds it from document stores', async () => {
  // Every relational engine gets the same toolset — the branch in tools.ts is
  // document-vs-relational, not per-engine, so a new SQL engine must land on this side of it
  // without any change there. Oracle is asserted alongside postgres for exactly that reason.
  for (const engine of ['postgres', 'sqlserver', 'oracle'] as const) {
    const relational = createSchemaToolset(stubDriver(), engine, 'analytics');
    assert.deepEqual(
      relational.specs.map((s) => s.name),
      ['list_schemas', 'list_tables', 'describe_tables'],
      `${engine} should get the relational toolset`,
    );
    for (const spec of relational.specs) {
      const properties = spec.parameters.properties as Record<string, unknown>;
      if (spec.name === 'list_schemas') continue;
      assert.equal('schema' in properties, true, `${engine}/${spec.name} lost its schema argument`);
    }
  }

  // MongoDB's "collections" node is a synthetic placeholder, not a real schema layer.
  // Offering it cost two round-trips per question and taught the model nothing.
  const document = createSchemaToolset(stubDriver(), 'mongodb', 'logs');
  assert.deepEqual(
    document.specs.map((s) => s.name),
    ['list_tables', 'describe_tables'],
  );
  // Nor does a schema argument survive on the tools that remain.
  for (const spec of document.specs) {
    const properties = spec.parameters.properties as Record<string, unknown>;
    assert.equal('schema' in properties, false, `${spec.name} still takes a schema argument`);
  }

  // A model that calls it anyway is told what does exist, rather than being handed
  // the synthetic group as though it meant something.
  const outcome = await document.run({ id: 'c1', name: 'list_schemas', args: {} });
  assert.match(outcome.content, /no tool called "list_schemas"/);
  assert.match(outcome.content, /list_tables, describe_tables/);
});

test('samples fields for document stores, which have no column catalog', async () => {
  const mongoTree: SchemaTree = {
    databases: [{ name: 'logs', schemas: [{ name: 'collections', tables: [{ name: 'events', columns: [] }] }] }],
  };
  const driver = stubDriver({
    async getSchemaTree() {
      return mongoTree;
    },
    async inferFields() {
      return [{ name: 'level', type: 'string', nullable: false }];
    },
  });

  const toolset = createSchemaToolset(driver, 'mongodb', 'logs');
  const outcome = await toolset.run({
    id: 'c1',
    name: 'describe_tables',
    args: { tables: ['events'] },
  });
  assert.match(outcome.content, /level string NOT NULL/);
  assert.match(outcome.label, /Reading fields for events/);

  // Collections are never qualified by the synthetic node — "collections.events" would
  // invite db.collections.events, which is not a collection that exists.
  const listed = await toolset.run({ id: 'c2', name: 'list_tables', args: {} });
  assert.equal(listed.content, 'events');

  const relational = createSchemaToolset(stubDriver(), 'postgres', 'analytics');
  const relationalList = await relational.run({ id: 'c3', name: 'list_tables', args: {} });
  assert.match(relationalList.content, /public\.orders/);
});

test('gives up rather than looping forever on a model that never answers', async () => {
  const adapter = scriptedAdapter([
    { text: '', toolCalls: [{ id: 'c1', name: 'list_tables', args: {} }] },
  ]);
  await assert.rejects(
    () => runAgent(baseRequest(adapter, stubDriver())),
    /kept inspecting the schema/,
  );
});

test('an unknown tool name is answered, not thrown', async () => {
  const toolset = createSchemaToolset(stubDriver(), 'postgres', 'analytics');
  const outcome = await toolset.run({ id: 'c1', name: 'run_query', args: {} });
  assert.match(outcome.content, /no tool called "run_query"/);
});

test('read_editor hands back the whole buffer when nothing is selected', async () => {
  const toolset = createSchemaToolset(stubDriver(), 'postgres', 'analytics', {
    text: 'SELECT * FROM orders;',
    isSelection: false,
  });

  assert.deepEqual(
    toolset.specs.map((s) => s.name),
    ['list_schemas', 'list_tables', 'describe_tables', 'read_editor'],
  );

  const outcome = await toolset.run({ id: 'c1', name: 'read_editor', args: {} });
  assert.equal(outcome.label, 'Reading the editor');
  assert.match(outcome.content, /SELECT \* FROM orders;/);
  assert.match(outcome.content, /full contents/);
});

test('read_editor hands back only the selection, and says so', async () => {
  const toolset = createSchemaToolset(stubDriver(), 'postgres', 'analytics', {
    text: 'SUM(total) AS revenue',
    isSelection: true,
  });

  const outcome = await toolset.run({ id: 'c1', name: 'read_editor', args: {} });
  assert.equal(outcome.label, 'Reading the selected query');
  assert.match(outcome.content, /SUM\(total\) AS revenue/);
  // The model has to know it is looking at a fragment: an edit that rewrites the surrounding
  // query would be inserted over the selection alone and lose the rest.
  assert.match(outcome.content, /Nothing outside it is shown/);
  assert.match(outcome.content, /only this fragment/);
});

test('an empty tab is not offered a read_editor tool at all', async () => {
  // A tool that can only answer "nothing here" is a round-trip spent learning nothing, so
  // the honest signal on an untouched tab is that it does not exist.
  const toolset = createSchemaToolset(stubDriver(), 'postgres', 'analytics');
  assert.equal(
    toolset.specs.some((s) => s.name === 'read_editor'),
    false,
  );

  const outcome = await toolset.run({ id: 'c1', name: 'read_editor', args: {} });
  assert.match(outcome.content, /no tool called "read_editor"/);
});

test('a buffer larger than the cap is truncated with the overflow named', async () => {
  const text = 'x'.repeat(MAX_EDITOR_CHARS + 500);
  const toolset = createSchemaToolset(stubDriver(), 'postgres', 'analytics', {
    text,
    isSelection: false,
  });

  const outcome = await toolset.run({ id: 'c1', name: 'read_editor', args: {} });
  assert.match(outcome.content, /truncated, 500 more characters/);
  assert.equal(outcome.content.includes(text), false);
});

test('the prompt tells the model the editor is worth reading, without quoting it', async () => {
  const adapter = scriptedAdapter([{ text: 'It totals orders by month.', toolCalls: [] }]);
  const secret = 'SELECT * FROM "public"."orders"';

  await runAgent({
    ...baseRequest(adapter, stubDriver()),
    question: 'what does this query do?',
    toolset: createSchemaToolset(stubDriver(), 'postgres', 'analytics', {
      text: secret,
      isSelection: false,
    }),
    editor: { lines: 1, isSelection: false },
  });

  const system = adapter.calls[0].system;
  assert.match(system, /read_editor/);
  assert.match(system, /1 line/);
  // Presence, not content: the query itself costs tokens only if the model asks for it.
  assert.equal(system.includes(secret), false);

  // read_editor is where an edit starts, not the whole of it. Worded as "call read_editor
  // before answering anything that asks for an edit", models took it for the complete recipe
  // and rewrote queries straight out of the buffer, inventing column names on the way.
  assert.match(system, /Start with read_editor/);
  assert.match(system, /where the work\s+starts, never the whole of it/);
  assert.match(system, /not when\s+editing one that already exists/);
});

test('a question about an existing query may be answered in prose alone', async () => {
  // The counterpart to the clarifying-question case: an explanation is a complete answer, and
  // a fence there would offer to replace a query the user never asked to change.
  const { note, sql } = extractQuery(
    'It totals each order and keeps only the ones above 100, newest first.',
  );
  assert.equal(sql, null);
  assert.equal(note, 'It totals each order and keeps only the ones above 100, newest first.');
});

test('extractQuery takes the longest fence and strips it from the note', () => {
  const { note, sql } = extractQuery('Here you go:\n\n```sql\nSELECT 1;\n```\n\nHope that helps.');
  assert.equal(sql, 'SELECT 1;');
  assert.equal(note, 'Here you go:\n\nHope that helps.');
});

test('extractQuery returns no query when the model asked a question back', () => {
  const { note, sql } = extractQuery('Which table did you mean?');
  assert.equal(sql, null);
  assert.equal(note, 'Which table did you mean?');
});

test('resolveBaseUrl rejects anything that is not a plain http(s) endpoint', () => {
  assert.equal(resolveBaseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
  // Loopback and private addresses are allowed on purpose — a local model server is the
  // point of the openai_compatible provider kind.
  assert.equal(resolveBaseUrl('http://192.168.1.9:8000'), 'http://192.168.1.9:8000');

  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com']) {
    assert.throws(() => resolveBaseUrl(bad), AiRequestError, bad);
  }
  assert.throws(() => resolveBaseUrl('https://user:secret@example.com'), /API key field/);
  assert.throws(() => resolveBaseUrl('https://example.com?key=abc'), /query string/);
  assert.throws(() => resolveBaseUrl(''), /needs a base URL/);
});
