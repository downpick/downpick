import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { MessageBoxOptions } from 'electron';
import type { UpdateCheckResult } from 'electron-updater';
import { UpdateController, UpdateUI, unsupportedUpdateReason } from './updateController';

const info = { version: '1.3.0', files: [], path: 'update.zip', sha512: 'checksum', releaseDate: '' };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  available = false;
  checks = 0;
  downloads = 0;
  installs = 0;
  checkGate = Promise.resolve();
  checkError?: Error;
  downloadError?: Error;

  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.checks++;
    await this.checkGate;
    if (this.checkError) {
      this.emit('error', this.checkError);
      throw this.checkError;
    }
    this.emit(this.available ? 'update-available' : 'update-not-available', info);
    return { updateInfo: info, versionInfo: info, isUpdateAvailable: this.available };
  }
  async downloadUpdate(): Promise<string[]> {
    this.downloads++;
    if (this.downloadError) {
      this.emit('error', this.downloadError);
      throw this.downloadError;
    }
    this.emit('download-progress', { percent: 50 });
    this.emit('update-downloaded', { ...info, downloadedFile: '/tmp/update.zip' });
    return ['/tmp/update.zip'];
  }
  quitAndInstall(): void { this.installs++; }
}

function fixture(unsupportedReason?: string) {
  const updater = new FakeUpdater();
  const dialogs: MessageBoxOptions[] = [];
  const state = { running: false, response: 1, releasesOpened: 0, prepareCalls: 0, recoverCalls: 0 };
  let install: (() => void) | undefined;
  const ui: UpdateUI = {
    show: async (options) => { dialogs.push(options); return state.response; },
    openReleases: async () => { state.releasesOpened++; },
    hasRunningQueries: () => state.running,
    quitWith: (callback) => { state.prepareCalls++; install = callback; },
    installationFailed: () => { state.recoverCalls++; },
    changed: () => {},
    log: () => {},
  };
  const controller = new UpdateController(updater, ui, unsupportedReason);
  return { updater, controller, ui, dialogs, state, finishShutdown: () => install?.() };
}

test('only supported packaged distributions use automatic updates', () => {
  const options = { packaged: true, configured: true, platform: 'win32',
    appImage: false, portable: false, macDeveloperSigned: false };
  assert.equal(unsupportedUpdateReason(options), undefined);
  assert.match(unsupportedUpdateReason({ ...options, packaged: false })!, /installed release/);
  assert.match(unsupportedUpdateReason({ ...options, configured: false })!, /no update feed/);
  assert.match(unsupportedUpdateReason({ ...options, portable: true })!, /Portable/);
  assert.match(unsupportedUpdateReason({ ...options, platform: 'darwin' })!, /Developer ID/);
  assert.equal(unsupportedUpdateReason({ ...options, platform: 'darwin', macDeveloperSigned: true }), undefined);
  assert.match(unsupportedUpdateReason({ ...options, platform: 'linux' })!, /AppImage/);
  assert.equal(unsupportedUpdateReason({ ...options, platform: 'linux', appImage: true }), undefined);
});

test('unsupported builds stay offline and open downloads only on a manual request', async () => {
  const f = fixture('Install a supported build.');
  await f.controller.check();
  assert.equal(f.dialogs.length, 0);
  f.state.response = 0;
  await f.controller.check(true);
  assert.equal(f.updater.checks, 0);
  assert.equal(f.state.releasesOpened, 1);
});

test('background checks are quiet; manual checks report no update', async () => {
  const f = fixture();
  await f.controller.check();
  assert.equal(f.dialogs.length, 0);
  await f.controller.check(true);
  assert.match(f.dialogs[0].message, /up to date/);
  assert.equal(f.updater.downloads, 0);
});

test('concurrent checks share one request and preserve manual feedback', async () => {
  const f = fixture();
  let resolve!: () => void;
  f.updater.checkGate = new Promise<void>((done) => { resolve = done; });
  const check = f.controller.check();
  await f.controller.check(true);
  assert.equal(f.updater.checks, 1);
  resolve();
  await check;
  assert.equal(f.dialogs.length, 1);
});

test('downloads automatically but Later never installs or repeats the prompt in the background', async () => {
  const f = fixture();
  f.updater.available = true;
  await f.controller.check();
  await flush();
  assert.equal(f.updater.downloads, 1);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowPrerelease, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.controller.menuLabel, 'Restart and Update…');
  await f.controller.check();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.updater.checks, 1);
  f.state.response = 0;
  await f.controller.check(true);
  assert.equal(f.state.prepareCalls, 1);
  assert.equal(f.updater.installs, 0, 'installer must wait for database shutdown');
  f.finishShutdown();
  assert.equal(f.updater.installs, 1);
});

test('running queries block restart, including a query started while the dialog is open', async () => {
  const f = fixture();
  f.updater.available = true;
  f.state.running = true;
  f.state.response = 0;
  await f.controller.check();
  await flush();
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.dialogs[0].message, 'Update ready');
  f.state.running = false;
  const originalShow = f.ui.show;
  f.ui.show = async (options) => {
    if (options.buttons?.includes('Restart and Update')) f.state.running = true;
    return originalShow(options);
  };
  await f.controller.check(true);
  assert.equal(f.state.prepareCalls, 0);
  assert.equal(f.dialogs.at(-1)?.message, 'Queries are still running');
});

test('network failures permit retries and do not duplicate error dialogs', async () => {
  const f = fixture();
  f.updater.checkError = new Error('offline');
  await f.controller.check();
  assert.equal(f.dialogs.length, 0);
  await f.controller.check(true);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.controller.menuLabel, 'Check for Updates…');
  f.updater.checkError = undefined;
  f.updater.available = true;
  f.updater.downloadError = new Error('checksum mismatch');
  await f.controller.check(true);
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.state.prepareCalls, 0);
  f.updater.downloadError = undefined;
  await f.controller.check(true);
  await flush();
  assert.equal(f.controller.menuLabel, 'Restart and Update…');
});

test('quitting during a check prevents a late download or dialog', async () => {
  const f = fixture();
  f.updater.available = true;
  let resolve!: () => void;
  f.updater.checkGate = new Promise<void>((done) => { resolve = done; });
  const check = f.controller.check(true);
  f.controller.stop();
  resolve();
  await check;
  assert.equal(f.updater.downloads, 0);
  assert.equal(f.dialogs.length, 0);
});

test('quitting while the restart dialog is open prevents a late install', async () => {
  const f = fixture();
  f.updater.available = true;
  let resolve!: (response: number) => void;
  f.ui.show = () => new Promise<number>((done) => { resolve = done; });
  await f.controller.check();
  f.controller.stop();
  resolve(0);
  await flush();
  assert.equal(f.state.prepareCalls, 0);
});

test('a native installation error restores the ability to check again', async () => {
  const f = fixture();
  f.updater.available = true;
  await f.controller.check();
  await flush();
  f.state.response = 0;
  await f.controller.check(true);
  f.finishShutdown();
  assert.equal(f.controller.menuLabel, 'Installing Update…');
  f.updater.emit('error', new Error('native signature validation failed'));
  await flush();
  assert.equal(f.state.recoverCalls, 1);
  assert.equal(f.controller.menuLabel, 'Check for Updates…');
  f.updater.available = false;
  await f.controller.check(true);
  assert.equal(f.updater.checks, 2);
});
