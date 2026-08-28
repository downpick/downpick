import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VaultCorruptError, WrongPasswordError } from './crypto';
import * as store from './store';
import { StoredConnection } from './types';

const PASSWORD = 'a master password';

let dir: string;
let vaultFile: string;

function connection(id: string): StoredConnection {
  return {
    id,
    name: `conn-${id}`,
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: `secret-${id}`,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downpick-vault-'));
  vaultFile = path.join(dir, 'vault.enc');
  // Also resets the rollback guard and locks whatever the previous test left open.
  store.setVaultPath(vaultFile);
});

test('creates, persists and reopens a vault', async () => {
  assert.deepEqual(store.getStatus(), { initialized: false, locked: true });

  await store.createVaultFile(PASSWORD);
  await store.mutate((p) => p.connections.push(connection('a')));
  assert.deepEqual(store.getStatus(), { initialized: true, locked: false });

  await store.lock();
  assert.equal(store.isLocked(), true);
  assert.throws(() => store.read(), store.VaultLockedError);
  await assert.rejects(() => store.mutate(() => undefined), store.VaultLockedError);

  await store.unlock(PASSWORD);
  assert.equal(store.read().connections[0].password, 'secret-a');
});

test('writes the vault and its backup owner-readable only', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX modes do not apply on Windows');
  await store.createVaultFile(PASSWORD);
  await store.mutate((p) => p.connections.push(connection('a')));

  assert.equal(fs.statSync(vaultFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${vaultFile}.bak`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('leaves no temp file behind, and ignores a stray one from a crashed write', async () => {
  await store.createVaultFile(PASSWORD);
  const before = fs.readFileSync(vaultFile, 'utf-8');

  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'a completed write must not leave a temp file',
  );

  // Simulate a crash between writing the temp file and renaming it over the vault.
  fs.writeFileSync(path.join(dir, '.vault.enc.999.1.tmp'), 'garbage', { mode: 0o600 });

  await store.lock();
  await store.unlock(PASSWORD);
  assert.equal(fs.readFileSync(vaultFile, 'utf-8'), before, 'the original vault must survive');
});

test('serializes concurrent mutations without losing writes', async () => {
  await store.createVaultFile(PASSWORD);

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.mutate((p) => p.connections.push(connection(String(i))))),
  );

  assert.equal(store.read().connections.length, 20);
  await store.lock();
  await store.unlock(PASSWORD);
  const reloaded = store.read().connections;
  assert.equal(reloaded.length, 20, 'every write must survive a round trip through disk');
  assert.deepEqual(
    new Set(reloaded.map((c) => c.id)),
    new Set(Array.from({ length: 20 }, (_, i) => String(i))),
  );
});

test('refuses a payload whose write sequence has gone backwards', async () => {
  await store.createVaultFile(PASSWORD);
  await store.mutate((p) => p.connections.push(connection('keep')));
  const oldCopy = fs.readFileSync(vaultFile);

  await store.mutate((p) => {
    p.connections.length = 0;
  });

  // An attacker (or a well-meaning user) restores the backup to bring the deleted
  // connection back. The file is perfectly valid; only its sequence gives it away.
  await store.lock();
  fs.writeFileSync(vaultFile, oldCopy);
  await assert.rejects(() => store.unlock(PASSWORD), VaultCorruptError);
});

test('rejects a write when the file changed underneath us', async () => {
  await store.createVaultFile(PASSWORD);
  await store.mutate((p) => p.connections.push(connection('a')));

  // Another process wrote the vault while this one held it open.
  const stat = fs.statSync(vaultFile);
  fs.utimesSync(vaultFile, stat.atime, new Date(stat.mtimeMs + 5000));

  await assert.rejects(
    () => store.mutate((p) => p.connections.push(connection('b'))),
    /changed on disk/,
  );
});

test('changing the password rotates access and removes the stale backup', async () => {
  await store.createVaultFile(PASSWORD);
  await store.mutate((p) => p.connections.push(connection('a')));
  assert.ok(fs.existsSync(`${vaultFile}.bak`), 'precondition: a backup exists');

  await store.changePassword(PASSWORD, 'the next master password');

  assert.equal(
    fs.existsSync(`${vaultFile}.bak`),
    false,
    'the backup is still wrapped with the old password and holds every secret',
  );

  await store.lock();
  await assert.rejects(() => store.unlock(PASSWORD), WrongPasswordError);
  await store.unlock('the next master password');
  assert.equal(store.read().connections[0].password, 'secret-a');
});

test('changing the password requires the current one', async () => {
  await store.createVaultFile(PASSWORD);
  await assert.rejects(() => store.changePassword('not the password', 'whatever'), WrongPasswordError);
  // The failed attempt must not have disturbed the vault.
  await store.lock();
  await store.unlock(PASSWORD);
});

test('status listeners see every transition of the lock gate', async () => {
  const seen: string[] = [];
  const stop = store.onStatusChange((s) => seen.push(`${s.initialized ? 'init' : 'new'}/${s.locked ? 'locked' : 'open'}`));

  await store.createVaultFile(PASSWORD);
  await store.lock();
  // Already locked — a no-op transition must stay quiet, or every shutdown would report one.
  await store.lock();
  await store.unlock(PASSWORD);

  // Switching vaults locks and then lands on a file that does not exist yet, so the status
  // reported has to be the *new* path's, not the one we just left.
  store.setVaultPath(path.join(dir, 'other.enc'));

  assert.deepEqual(seen, ['init/open', 'init/locked', 'init/open', 'new/locked']);

  stop();
  await store.createVaultFile(PASSWORD);
  assert.equal(seen.length, 4, 'unsubscribing stops the notifications');
});

test('switching vaults tears the drivers down too, not just the keys', async () => {
  let teardowns = 0;
  store.setLockHandler(async () => {
    teardowns += 1;
  });
  await store.createVaultFile(PASSWORD);

  store.setVaultPath(path.join(dir, 'elsewhere.enc'));
  // Not awaited by `setVaultPath` itself — it is synchronous — so give the handler a turn.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.isLocked(), true);
  assert.equal(teardowns, 1, 'the databases from the vault we left must not stay queryable');
  store.setLockHandler(async () => {});
});
