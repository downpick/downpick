import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessages } from './aiHistory';

/**
 * The transcript arriving over IPC is untrusted input, and a save is a background side
 * effect of asking a question — so the rule is coerce and truncate, never reject, matching
 * `parseHistory` in ai.ts.
 */

test('drops entries that are not usable messages', () => {
  const parsed = parseMessages([
    { role: 'user', text: 'keep me', sql: null, trace: [], isError: false },
    { role: 42, text: 'bad role' },
    { role: 'user' },
    { role: 'assistant', text: 7 },
    'not an object',
    null,
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, 'keep me');
});

test('is not fooled by a non-array', () => {
  assert.deepEqual(parseMessages(undefined), []);
  assert.deepEqual(parseMessages('a transcript'), []);
  assert.deepEqual(parseMessages({ 0: { role: 'user', text: 'x' } }), []);
});

test('normalises the optional fields rather than trusting them', () => {
  const [message] = parseMessages([
    { role: 'assistant', text: 'answer', sql: 12345, trace: 'nope', isError: 'yes' },
  ]);

  assert.equal(message.sql, null, 'a non-string sql becomes null, not "12345"');
  assert.deepEqual(message.trace, []);
  assert.equal(message.isError, false, 'only a real boolean true counts as an error');
});

test('keeps only well-formed trace steps, capped', () => {
  const [message] = parseMessages([
    {
      role: 'assistant',
      text: 'answer',
      sql: null,
      isError: false,
      trace: [{ label: 'good' }, { label: 9 }, {}, ...Array(40).fill({ label: 'flood' })],
    },
  ]);

  assert.equal(message.trace.length, 20);
  assert.equal(message.trace[0].label, 'good');
});

test('truncates oversized input instead of refusing it', () => {
  const flood = Array(500).fill({
    role: 'user',
    text: 'x'.repeat(50_000),
    sql: 'y'.repeat(50_000),
    trace: [{ label: 'z'.repeat(1000) }],
    isError: false,
  });

  const parsed = parseMessages(flood);
  assert.equal(parsed.length, 200);
  assert.equal(parsed[0].text.length, 20_000);
  assert.equal(parsed[0].sql?.length, 20_000);
  assert.equal(parsed[0].trace[0].label.length, 300);
});
