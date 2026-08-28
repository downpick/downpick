import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Same preamble as dispatch.test.ts: redirect the home directory before anything resolves
// ~/.downpick, because these modules read their paths at load time and imports hoist.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'downpick-vault-path-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

/* eslint-disable @typescript-eslint/no-var-requires */
const { bootstrap } = require('./bootstrap') as typeof import('./bootstrap');
const { dispatch } = require('./dispatch') as typeof import('./dispatch');
import type { Envelope } from './channels';

const SETTINGS_PATH = path.join(HOME, '.downpick', 'settings.json');
const VAULT_A = path.join(HOME, 'elsewhere', 'work.enc');
const VAULT_B = path.join(HOME, 'other', 'personal.enc');
const PASSWORD_A = 'a very long master password';
const PASSWORD_B = 'a different long master password';

async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const envelope = (await dispatch(channel, payload)) as Envelope<T>;
  assert.equal(envelope.ok, true, `${channel} failed: ${JSON.stringify(envelope)}`);
  return (envelope as { ok: true; data: T }).data;
}

async function fails(
  channel: string,
  payload?: unknown,
): Promise<{ status: number; error: string }> {
  const envelope = await dispatch(channel, payload);
  assert.equal(envelope.ok, false, `${channel} unexpectedly succeeded`);
  return envelope as { ok: false; status: number; error: string };
}

/** The vault the next launch would open. */
function configuredPath(): string {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')).vaultFilePath;
}

before(() => {
  bootstrap();
});

// The first-run screen's "create a new vault" door. `settings:update` is behind the vault
// gate, so carrying the path on vault:setup is the only way to place the very first vault
// somewhere other than the default.
test('setup creates the vault at the chosen path and remembers it', async () => {
  await ok('vault:setup', { password: PASSWORD_A, vaultFilePath: VAULT_A });

  assert.ok(fs.existsSync(VAULT_A), 'the vault must be created where the user asked for it');
  assert.deepEqual(await ok('vault:status'), {
    initialized: true,
    locked: false,
    path: VAULT_A,
  });
  assert.equal(configuredPath(), VAULT_A);
});

test('refuses to create a second vault over the chosen path', async () => {
  const res = await fails('vault:setup', { password: PASSWORD_B, vaultFilePath: VAULT_A });
  assert.equal(res.status, 409);
});

test('a failed unlock never repoints the next launch at the file it failed on', async () => {
  // Move to a second vault, so there is a configured path worth protecting.
  await ok('vault:setup', { password: PASSWORD_B, vaultFilePath: VAULT_B });
  assert.equal(configuredPath(), VAULT_B);
  await ok('vault:lock');

  const wrong = await fails('vault:unlock', {
    password: 'not the password',
    vaultFilePath: VAULT_A,
  });
  assert.equal(wrong.status, 401);

  // The candidate stays live in memory, so retyping the password reopens it without picking
  // the file again — but a restart still comes back to the vault that last actually opened.
  assert.equal((await ok<{ path: string }>('vault:status')).path, VAULT_A);
  assert.equal(configuredPath(), VAULT_B, 'a wrong password must not strand the next launch');

  await ok('vault:unlock', { password: PASSWORD_A, vaultFilePath: VAULT_A });
  assert.equal(configuredPath(), VAULT_A, 'a vault that opened is the one worth returning to');
});
