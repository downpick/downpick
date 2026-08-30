import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNotification } from './notifyPolicy';

const ON = { notifyOnQueryFinish: true, notifyAfterSeconds: 10 };
const AWAY = { inFront: false };
const WATCHING = { inFront: true };

/** A run that finished normally, in `ms`. */
const ran = (ms: number) => ({ elapsedMs: ms, outcome: 'success' as const });
/** A run the configured query timeout cancelled after `ms`. */
const killed = (ms: number) => ({ elapsedMs: ms, outcome: 'timeout' as const });

test('says nothing at all while the setting is off', () => {
  const off = { notifyOnQueryFinish: false, notifyAfterSeconds: 0 };
  assert.equal(decideNotification(ran(60_000), off, AWAY, true), 'none');
  // The off switch outranks the timeout exemption below — it means "do not notify me".
  assert.equal(decideNotification(killed(60_000), off, AWAY, true), 'none');
});

test('stays quiet for a query the user watched finish', () => {
  assert.equal(decideNotification(ran(9_999), ON, AWAY, true), 'none');
  // The threshold is inclusive at the boundary — "notify after 10s" includes exactly 10s.
  assert.equal(decideNotification(ran(10_000), ON, AWAY, true), 'native');
});

test('a threshold of zero announces every query', () => {
  const always = { notifyOnQueryFinish: true, notifyAfterSeconds: 0 };
  assert.equal(decideNotification(ran(0), always, AWAY, true), 'native');
});

test('an unusable elapsed time is not treated as an infinitely long query', () => {
  assert.equal(decideNotification(ran(NaN), ON, AWAY, true), 'none');
});

test('a timeout is announced however quickly it fired', () => {
  // The trap this closes: a 5s query timeout under a 10s notification threshold. The query
  // was killed at 5s, which is under the threshold — and the whole point of setting a query
  // timeout is to be told when it trips.
  assert.equal(decideNotification(killed(5_000), ON, AWAY, true), 'native');
  assert.equal(decideNotification(killed(0), ON, AWAY, true), 'native');
  // Still routed by where the user is looking, like any other announcement.
  assert.equal(decideNotification(killed(5_000), ON, WATCHING, true), 'toast');
});

test('keeps a desktop banner off the answer the user is already reading', () => {
  assert.equal(decideNotification(ran(60_000), ON, WATCHING, true), 'toast');
});

test('falls back to the in-app notice when nothing native can be shown', () => {
  // No window to activate, or a platform without notifications: the toast still waits on
  // screen for whenever the user comes back.
  assert.equal(decideNotification(ran(60_000), ON, null, true), 'toast');
  assert.equal(decideNotification(ran(60_000), ON, AWAY, false), 'toast');
});
