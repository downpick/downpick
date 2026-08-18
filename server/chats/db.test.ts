import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AiMessageInput,
  clearConversations,
  deleteConversation,
  deriveTitle,
  getConversation,
  listConversations,
  saveConversation,
} from '../aiChats';
import { closeChats, isAvailable, setChatsDbPath, withDb } from './db';

let dir: string;
let dbFile: string;

function ask(text: string): AiMessageInput {
  return { role: 'user', text, sql: null, trace: [], isError: false };
}

function answer(text: string, sql: string | null = null): AiMessageInput {
  return { role: 'assistant', text, sql, trace: [], isError: false };
}

function save(messages: AiMessageInput[], conversationId: string | null = null) {
  return saveConversation({
    conversationId,
    connectionId: 'conn-1',
    connectionName: 'Local',
    database: 'appdb',
    messages,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downpick-chats-'));
  dbFile = path.join(dir, 'chats.db');
  // Also closes whatever the previous test left open and clears the open-failure latch.
  setChatsDbPath(dbFile);
});

test('saves a conversation and lists it with a derived title', () => {
  const saved = save([ask('  How many   orders shipped?\n'), answer('Here you go.')]);
  assert.ok(saved);

  const page = listConversations({ limit: 10 });
  assert.equal(page.available, true);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);

  const [item] = page.items;
  assert.equal(item.id, saved.id);
  // Whitespace collapsed onto one line — the raw question had a newline and a double space.
  assert.equal(item.title, 'How many orders shipped?');
  assert.equal(item.connectionName, 'Local');
  assert.equal(item.database, 'appdb');
  assert.equal(item.messageCount, 2);
});

test('saving the same id updates in place and replaces the transcript', () => {
  const first = save([ask('one'), answer('a'), answer('b')]);
  assert.ok(first);
  assert.equal(getConversation(first.id)?.messages.length, 3);

  const again = save([ask('one'), answer('replaced')], first.id);
  assert.equal(again?.id, first.id);

  const page = listConversations({ limit: 10 });
  assert.equal(page.items.length, 1, 'must update the row, not insert a second one');

  const detail = getConversation(first.id);
  assert.equal(detail?.messages.length, 2, 'old messages must be gone, not merged');
  assert.equal(detail?.messages[1].text, 'replaced');
});

test('round-trips sql, trace and isError in order, with no runtime fields', () => {
  const saved = save([
    ask('show me the users'),
    {
      role: 'assistant',
      text: 'This lists them.',
      sql: 'SELECT * FROM users;',
      trace: [{ label: 'list_tables' }, { label: 'describe_tables(users)' }],
      isError: false,
    },
    { role: 'assistant', text: 'That failed.', sql: null, trace: [], isError: true },
  ]);
  assert.ok(saved);

  const detail = getConversation(saved.id);
  assert.ok(detail);
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ['user', 'assistant', 'assistant'],
  );
  assert.equal(detail.messages[1].sql, 'SELECT * FROM users;');
  assert.deepEqual(detail.messages[1].trace, [
    { label: 'list_tables' },
    { label: 'describe_tables(users)' },
  ]);
  assert.equal(detail.messages[1].isError, false);
  assert.equal(detail.messages[2].isError, true);
  assert.equal(detail.messages[2].sql, null);

  // The runtime half of AiChat must never reach disk — same split PersistedTab makes.
  for (const message of detail.messages) {
    for (const runtime of ['justInserted', 'thinking', 'liveTrace', 'draft']) {
      assert.equal(runtime in message, false, `${runtime} must not be persisted`);
    }
  }
});

test('message ids are unique across conversations', () => {
  const a = save([ask('first'), answer('a')]);
  const b = save([ask('second'), answer('b')]);
  assert.ok(a && b);

  const ids = [
    ...getConversation(a.id)!.messages.map((m) => m.id),
    ...getConversation(b.id)!.messages.map((m) => m.id),
  ];
  assert.equal(new Set(ids).size, ids.length, 'ids collide across conversations');
});

test('paginates without repeats or gaps, even when timestamps tie', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'].map((n) => save([ask(n), answer(n)])!.id);
  assert.equal(new Set(ids).size, 5);

  // Force every row to the same instant. Two saves inside one millisecond is entirely
  // reachable in practice, and this is what proves the cursor's `id DESC` tiebreak works —
  // without it a page boundary landing on a tie would skip or repeat rows.
  withDb((handle) => handle.exec('UPDATE conversations SET updated_at = 1000'), undefined);

  const seen: string[] = [];
  let cursor = null as ReturnType<typeof listConversations>['nextCursor'];
  for (let guard = 0; guard < 10; guard++) {
    const page = listConversations({ limit: 2, before: cursor });
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  assert.equal(seen.length, 5, 'every conversation should be paged through exactly once');
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test('deleting a conversation takes its messages with it', () => {
  const saved = save([ask('doomed'), answer('a'), answer('b')]);
  assert.ok(saved);

  assert.equal(deleteConversation(saved.id), true);
  assert.equal(deleteConversation(saved.id), false, 'second delete finds nothing');
  assert.equal(getConversation(saved.id), null);

  // Asserted directly rather than through the façade: this is really a test that
  // ON DELETE CASCADE is switched on, which is a node:sqlite default we should not
  // silently depend on.
  const orphans = withDb(
    (handle) => Number((handle.prepare('SELECT count(*) AS n FROM messages').get() as any).n),
    -1,
  );
  assert.equal(orphans, 0);
});

test('clear removes everything and reports how many', () => {
  save([ask('one'), answer('a')]);
  save([ask('two'), answer('b')]);

  assert.equal(clearConversations(), 2);
  assert.equal(listConversations({ limit: 10 }).items.length, 0);
  assert.equal(
    withDb(
      (handle) => Number((handle.prepare('SELECT count(*) AS n FROM messages').get() as any).n),
      -1,
    ),
    0,
  );
});

test('reopening the same file keeps the data and does not re-migrate', () => {
  const saved = save([ask('durable'), answer('a')]);
  assert.ok(saved);

  closeChats();

  const detail = getConversation(saved.id);
  assert.equal(detail?.title, 'durable');
  assert.equal(detail?.messages.length, 2);
  assert.equal(
    withDb(
      (handle) =>
        Number((handle.prepare('PRAGMA user_version').get() as any).user_version),
      -1,
    ),
    1,
    'migration must be idempotent',
  );
});

test('creates the database owner-only inside an owner-only directory', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX modes do not apply on Windows');
  save([ask('perms'), answer('a')]);

  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('degrades to unavailable on a corrupt file, and leaves it alone', () => {
  const broken = path.join(dir, 'broken.db');
  fs.writeFileSync(broken, 'not a database');
  setChatsDbPath(broken);

  assert.equal(isAvailable(), false);

  const page = listConversations({ limit: 10 });
  assert.deepEqual(page.items, []);
  assert.equal(page.available, false, 'the UI needs to tell "broken" from "empty"');

  // None of these may throw — a broken history file must not take the AI panel down.
  assert.equal(save([ask('lost'), answer('a')]), null);
  assert.equal(getConversation('anything'), null);
  assert.equal(deleteConversation('anything'), false);
  assert.equal(clearConversations(), 0);

  // It may be the user's only copy. Recovering by destroying it is not on the table.
  assert.equal(fs.readFileSync(broken, 'utf-8'), 'not a database');
});

test('deriveTitle collapses, truncates, and falls back', () => {
  assert.equal(deriveTitle([ask('  spaced   out\n\ttitle ')]), 'spaced out title');
  // No user turn at all — an assistant-only transcript still needs a label.
  assert.equal(deriveTitle([answer('just an answer')]), 'Untitled chat');
  assert.equal(deriveTitle([]), 'Untitled chat');
  assert.equal(deriveTitle([ask('   ')]), 'Untitled chat');

  const long = deriveTitle([ask('x'.repeat(500))]);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});
