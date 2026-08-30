import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { APP_USER_MODEL_ID } from './appId';

/**
 * Windows raises a toast only for an app whose AppUserModelID matches a Start Menu shortcut
 * it can find, and the shortcut's is whatever electron-builder stamped from `appId`. Renaming
 * one and not the other breaks notifications silently, in packaged Windows builds only — the
 * hardest combination to notice. So it is asserted here instead.
 */
test('the AppUserModelID matches the appId the installer stamps on the shortcut', () => {
  // Compiled to .electron-out/electron/, so the repo root is two levels up — the same hop
  // main.ts makes to find build/icon.png.
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'electron-builder.yml'),
    'utf-8',
  );

  // A one-line scalar at the top of the file; a YAML parser would be a dependency for it.
  const declared = /^appId:\s*(\S+)/m.exec(yml)?.[1];

  assert.ok(declared, 'electron-builder.yml no longer declares appId on a line of its own');
  assert.equal(APP_USER_MODEL_ID, declared);
});
