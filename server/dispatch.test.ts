import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Redirect the home directory before anything resolves ~/.downpick — these modules read
// their paths at load time, and `import` statements hoist above assignments.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'downpick-ipc-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

/* eslint-disable @typescript-eslint/no-var-requires */
const { bootstrap } = require('./bootstrap') as typeof import('./bootstrap');
const { dispatch, registeredChannels } = require('./dispatch') as typeof import('./dispatch');
const { CHANNELS } = require('./channels') as typeof import('./channels');
import type {
  AiConversationDetail,
  AiHistoryPage,
  AiStreamEvent,
  Envelope,
} from './channels';

const PASSWORD = 'a very long master password';
const VAULT_PATH = path.join(HOME, '.downpick', 'vault.enc');

/** Asserts the call succeeded and hands back its data. */
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const envelope = (await dispatch(channel, payload)) as Envelope<T>;
  assert.equal(envelope.ok, true, `${channel} failed: ${JSON.stringify(envelope)}`);
  return (envelope as { ok: true; data: T }).data;
}

/** Asserts the call failed and hands back the failure. */
async function fails(
  channel: string,
  payload?: unknown,
): Promise<{ status: number; error: string; line?: number }> {
  const envelope = await dispatch(channel, payload);
  assert.equal(envelope.ok, false, `${channel} unexpectedly succeeded`);
  return envelope as { ok: false; status: number; error: string; line?: number };
}

before(() => {
  bootstrap();
});

test('every declared channel has a handler', () => {
  const registered = new Set(registeredChannels());
  // These live in the Electron layer, which this suite deliberately does not load.
  const electronOnly = new Set<string>(['files:save', 'clipboard:write']);
  const missing = CHANNELS.filter((c) => !electronOnly.has(c) && !registered.has(c));
  assert.deepEqual(missing, [], 'channels declared but never wired');
});

test('rejects a channel that is not on the allowlist', async () => {
  const res = await fails('vault:destroy-everything' as never);
  assert.equal(res.status, 404);
});

test('locks everything until the vault is opened', async () => {
  assert.deepEqual(await ok('vault:status'), {
    initialized: false,
    locked: true,
    path: VAULT_PATH,
  });

  for (const channel of [
    'connections:list',
    'connections:create',
    'settings:validate',
    // History is not in the vault, but it is still the user's data and stays behind the gate.
    'ai:history:list',
    'ai:history:save',
  ]) {
    const res = await fails(channel, {});
    assert.equal(res.status, 423, channel);
  }

  // The shell needs settings to render the unlock screen, and they hold nothing secret.
  await ok('settings:get');
});

test('rejects a master password below the minimum length', async () => {
  const res = await fails('vault:setup', { password: 'short' });
  assert.equal(res.status, 400);
  assert.match(res.error, /at least 12/);
});

// Every test below depends on this having run — it is the only place the vault is created.
test('setup creates an empty vault and opens everything else', async () => {
  assert.deepEqual(await ok('vault:setup', { password: PASSWORD }), { ok: true });
  assert.ok(fs.existsSync(VAULT_PATH));

  assert.deepEqual(await ok('vault:status'), {
    initialized: true,
    locked: false,
    path: VAULT_PATH,
  });
  assert.deepEqual(await ok('connections:list'), []);
});

test('refuses to create a second vault over an existing one', async () => {
  const res = await fails('vault:setup', { password: 'another perfectly long password' });
  assert.equal(res.status, 409);
});

test('never returns a password to the renderer', async () => {
  await ok('connections:create', {
    name: 'New',
    type: 'postgres',
    host: 'db.internal',
    port: 5432,
    username: 'app',
    password: 'do-not-leak-me',
  });

  const list = await ok<Record<string, unknown>[]>('connections:list');
  assert.ok(
    !JSON.stringify(list).includes('do-not-leak-me'),
    'the connection list must never carry secrets',
  );
  for (const connection of list) assert.ok(!('password' in connection));
});

test('deleting a connection deletes its password with it', async () => {
  const { id } = await ok<{ id: string }>('connections:create', {
    name: 'Temp',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'u',
    password: 'orphan-candidate',
  });

  await ok('connections:delete', { id });

  // Read the encrypted file itself, rather than the in-memory state, to prove the secret
  // does not survive the delete anywhere.
  const store = require('./vault/store') as typeof import('./vault/store');
  assert.equal(
    (await store.verifyOnDisk(PASSWORD)).connections.some((c) => c.password === 'orphan-candidate'),
    false,
  );

  assert.equal((await fails('connections:delete', { id })).status, 404);
});

test('locking closes everything again and the right password reopens it', async () => {
  await ok('vault:lock');
  assert.equal((await fails('connections:list')).status, 423);

  const wrong = await fails('vault:unlock', { password: 'not the password' });
  assert.equal(wrong.status, 401);

  await ok('vault:unlock', { password: PASSWORD });
  await ok('connections:list');
});

test('a query error carries the line it failed on', async () => {
  const connections = require('./handlers/connections') as typeof import('./handlers/connections');
  const key = 'line-test::db';
  connections.activeConnections.set(key, {
    async testConnection() {},
    async getDatabases() {
      return ['db'];
    },
    async executeQuery() {
      // Shaped like a PostgreSQL syntax error: a 1-based character offset.
      throw Object.assign(new Error('syntax error at or near "SELCT"'), { position: '12' });
    },
    async getSchemaTree() {
      return { databases: [] };
    },
    async close() {},
  } as never);

  try {
    const res = await fails('query:run', {
      connectionId: 'line-test',
      database: 'db',
      sql: 'SELECT 1;\nSELCT 2;',
    });
    assert.equal(res.status, 400);
    assert.equal(res.line, 2, 'the offset must be resolved to a line the editor can mark');
  } finally {
    connections.activeConnections.delete(key);
  }
});

test('stores AI provider keys in the vault and never hands them back', async () => {
  const added = await ok<{ id: string; models: string[] }>('ai:providers:add', {
    provider: 'anthropic',
    label: 'Work key',
    apiKey: 'sk-ant-not-a-real-key',
    models: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'],
  });

  // Duplicate model ids are collapsed rather than shown twice in the picker.
  assert.deepEqual(added.models, ['claude-sonnet-4-5-20250929']);
  assert.equal('apiKey' in added, false);

  const listed = await ok<{ catalog: unknown[]; providers: unknown[] }>('ai:providers:list');
  assert.ok(listed.catalog.length >= 5, 'every provider kind is offered');
  assert.equal(
    JSON.stringify(listed).includes('sk-ant-not-a-real-key'),
    false,
    'the API key must never cross the bridge, the same rule connections follow',
  );

  // It is in the encrypted vault, though — that is where it has to be to be usable.
  const store = require('./vault/store') as typeof import('./vault/store');
  assert.equal(
    (await store.verifyOnDisk(PASSWORD)).aiProviders.find((p) => p.id === added.id)?.apiKey,
    'sk-ant-not-a-real-key',
  );

  // A blank key on update means "keep the stored one", like the connection password field.
  const patched = await ok<{ label: string }>('ai:providers:update', {
    id: added.id,
    label: 'Renamed',
    apiKey: '',
  });
  assert.equal(patched.label, 'Renamed');
  assert.equal(
    (await store.verifyOnDisk(PASSWORD)).aiProviders.find((p) => p.id === added.id)?.apiKey,
    'sk-ant-not-a-real-key',
  );

  await ok('ai:providers:delete', { id: added.id });
  // Removing the provider removes the key with it — the record is where the secret lives.
  assert.equal((await store.verifyOnDisk(PASSWORD)).aiProviders.length, 0);
});

test('refuses a self-hosted endpoint that is not a plain http(s) URL', async () => {
  for (const baseUrl of ['file:///etc/passwd', 'https://user:pass@example.com', '']) {
    const res = await fails('ai:providers:add', {
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl,
      models: ['m'],
    });
    assert.equal(res.status, 400, `expected ${baseUrl || '(empty)'} to be rejected`);
  }
});

test('AI chat is behind the same vault gate as everything else', async () => {
  const body = { providerId: 'nope', model: 'm', connectionId: 'c', database: 'd', question: 'hi' };

  await ok('vault:lock');
  assert.equal(
    (await fails('ai:chat:start', body)).status,
    423,
    'the keys live in the vault, so a locked vault means no chat',
  );

  await ok('vault:unlock', { password: PASSWORD });

  // Unlocked, but nothing is configured — a clear failure rather than a hung stream.
  const unconfigured = await fails('ai:chat:start', body);
  assert.equal(unconfigured.status, 404);
  assert.match(unconfigured.error, /no longer configured/);
});

test('streams the schema lookups and the finished query, without touching the database', async () => {
  const adapters = require('./ai/adapters') as typeof import('./ai/adapters');
  const connections = require('./handlers/connections') as typeof import('./handlers/connections');
  const ai = require('./handlers/ai') as typeof import('./handlers/ai');

  const { id: connectionId } = await ok<{ id: string }>('connections:create', {
    name: 'AI',
    type: 'postgres',
    host: 'h',
    port: 5432,
    username: 'u',
    password: 'p',
  });

  // A driver that fails the test if the assistant ever tries to run anything. Registered
  // under the same key the query handler uses, standing in for an opened database.
  let executed = false;
  connections.activeConnections.set(`${connectionId}::analytics`, {
    async testConnection() {},
    async getDatabases() {
      return ['analytics'];
    },
    async executeQuery() {
      executed = true;
      throw new Error('the assistant must never execute a query');
    },
    async getSchemaTree() {
      return {
        databases: [
          {
            name: 'analytics',
            schemas: [
              {
                name: 'public',
                tables: [
                  { name: 'orders', columns: [{ name: 'total', type: 'numeric', nullable: true }] },
                ],
              },
            ],
          },
        ],
      };
    },
    async close() {},
  } as never);

  // One tool round-trip, then the answer.
  let turn = 0;
  adapters.setAdapterFactory(() => ({
    async complete() {
      turn++;
      return turn === 1
        ? { text: '', toolCalls: [{ id: 't1', name: 'describe_tables', args: { tables: ['orders'] } }] }
        : { text: 'Every order.\n\n```sql\nSELECT total FROM "public"."orders";\n```', toolCalls: [] };
    },
    async listModels() {
      return ['gpt-4o'];
    },
  }));

  const provider = await ok<{ id: string }>('ai:providers:add', {
    provider: 'openai',
    apiKey: 'k',
    models: ['gpt-4o'],
  });

  try {
    // The events used to be NDJSON lines on a response socket; now they are pushed at the
    // emitter, which is the seam the Electron layer plugs a webContents into.
    const events: AiStreamEvent[] = [];
    const finished = new Promise<void>((resolve) => {
      ai.setAiStreamEmitter(({ event }) => {
        events.push(event);
        // `message` and `error` are terminal.
        if (event.type !== 'step') resolve();
      });
    });

    const { streamId } = await ok<{ streamId: string }>('ai:chat:start', {
      providerId: provider.id,
      model: 'gpt-4o',
      connectionId,
      database: 'analytics',
      question: 'show me every order total',
    });
    assert.ok(streamId, 'the panel needs an id to cancel and to filter events by');

    await finished;

    assert.deepEqual(events[0], { type: 'step', label: 'Reading columns for orders' });
    assert.equal(events[1].type, 'message');
    assert.equal((events[1] as { sql: string }).sql, 'SELECT total FROM "public"."orders";');
    assert.equal((events[1] as { note: string }).note, 'Every order.');
    assert.equal(executed, false, 'the assistant has no tool that runs a query');
  } finally {
    ai.setAiStreamEmitter(() => {});
    adapters.setAdapterFactory(null);
    connections.activeConnections.delete(`${connectionId}::analytics`);
    await ok('ai:providers:delete', { id: provider.id });
    await ok('connections:delete', { id: connectionId });
  }
});

test('lists models from the provider, for a saved key and an unsaved one alike', async () => {
  const adapters = require('./ai/adapters') as typeof import('./ai/adapters');
  let sawKey = '';
  adapters.setAdapterFactory(() => ({
    async complete() {
      throw new Error('not used here');
    },
    async listModels(req) {
      sawKey = req.apiKey;
      // Deliberately unsorted and duplicated — the handler normalizes both.
      return ['gpt-4o-mini', 'gpt-4o', 'gpt-4o'];
    },
  }));

  const { id } = await ok<{ id: string }>('ai:providers:add', {
    provider: 'openai',
    apiKey: 'stored-key',
    models: ['gpt-4o'],
  });

  try {
    // The add form's case: nothing saved yet, so the key travels in the payload.
    const unsaved = await ok<{ models: string[] }>('ai:providers:models', {
      provider: 'openai',
      apiKey: 'typed-key',
    });
    assert.deepEqual(unsaved.models, ['gpt-4o', 'gpt-4o-mini']);
    assert.equal(sawKey, 'typed-key');

    // A saved provider's case: the key stays in the main process and the renderer never sees it.
    await ok('ai:providers:models', { id });
    assert.equal(sawKey, 'stored-key');

    // No key anywhere is a clear failure, not a call with an empty string.
    const keyless = await fails('ai:providers:models', { provider: 'anthropic' });
    assert.equal(keyless.status, 400);
    assert.match(keyless.error, /API key/);

    // A provider that refuses to enumerate — the Azure case — must not block anything.
    adapters.setAdapterFactory(() => ({
      async complete() {
        throw new Error('not used here');
      },
      async listModels() {
        throw new (require('./ai/net') as typeof import('./ai/net')).AiRequestError(
          'The provider rejected the API key.',
        );
      },
    }));
    const refused = await fails('ai:providers:models', { id });
    assert.equal(refused.status, 400);
    assert.match(refused.error, /rejected the API key/);
  } finally {
    adapters.setAdapterFactory(null);
    await ok('ai:providers:delete', { id });
  }
});

test('a model added after the fact is kept, and the key survives the edit', async () => {
  const { id } = await ok<{ id: string }>('ai:providers:add', {
    provider: 'openai',
    apiKey: 'key-to-keep',
    models: ['gpt-4o'],
  });

  try {
    // This is what the picker's "Add" button does.
    const patched = await ok<{ models: string[] }>('ai:providers:update', {
      id,
      models: ['gpt-4o', 'o3-mini'],
    });
    assert.deepEqual(patched.models, ['gpt-4o', 'o3-mini']);

    const store = require('./vault/store') as typeof import('./vault/store');
    const onDisk = (await store.verifyOnDisk(PASSWORD)).aiProviders.find((p) => p.id === id);
    assert.deepEqual(onDisk?.models, ['gpt-4o', 'o3-mini']);
    assert.equal(onDisk?.apiKey, 'key-to-keep', 'editing models must not disturb the key');
  } finally {
    await ok('ai:providers:delete', { id });
  }
});

test('history round-trips through the channels: save, list, get, delete', async () => {
  const saved = await ok<{ id: string | null }>('ai:history:save', {
    conversationId: null,
    connectionId: 'conn-1',
    connectionName: 'Local',
    database: 'appdb',
    messages: [
      { role: 'user', text: 'which tables exist?', sql: null, trace: [], isError: false },
      {
        role: 'assistant',
        text: 'These ones.',
        sql: 'SELECT 1;',
        trace: [{ label: 'list_tables' }],
        isError: false,
      },
    ],
  });
  assert.ok(saved.id, 'save should mint a conversation id');

  const page = await ok<AiHistoryPage>('ai:history:list', {});
  assert.equal(page.available, true);
  const listed = page.items.find((i) => i.id === saved.id);
  assert.equal(listed?.title, 'which tables exist?');
  assert.equal(listed?.messageCount, 2);

  const detail = await ok<AiConversationDetail>('ai:history:get', { id: saved.id });
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].sql, 'SELECT 1;');
  assert.deepEqual(detail.messages[1].trace, [{ label: 'list_tables' }]);

  await ok('ai:history:delete', { id: saved.id });
  const gone = await fails('ai:history:get', { id: saved.id });
  assert.equal(gone.status, 404);
});

test('history rejects a save with nothing usable in it', async () => {
  // Every entry is malformed, so parseMessages drops them all and the save has no content.
  const res = await fails('ai:history:save', {
    connectionId: 'conn-1',
    database: 'appdb',
    messages: [{ role: 42, text: 'nope' }, { role: 'user' }, 'not an object'],
  });
  assert.equal(res.status, 400);
});
