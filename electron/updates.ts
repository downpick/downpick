import { app, BrowserWindow, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { hasRunningQueries } from '../server/handlers/query';
import { UpdateController, unsupportedUpdateReason } from './updateController';

const RELEASES_URL = 'https://github.com/downpick/downpick/releases/latest';

export function createUpdates(
  changed: () => void,
  quitWith: (install: () => void) => void,
  installationFailed: () => void,
) {
  let macDeveloperSigned = false;
  if (app.isPackaged && process.platform === 'darwin') {
    const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2',
      path.resolve(process.execPath, '../../..')], { encoding: 'utf8', timeout: 5000 });
    macDeveloperSigned = signature.status === 0 &&
      /^Authority=Developer ID Application:/m.test(signature.stderr ?? '');
  }

  const controller = new UpdateController(autoUpdater, {
    show: async (options) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      return result.response;
    },
    openReleases: () => shell.openExternal(RELEASES_URL),
    hasRunningQueries,
    quitWith,
    installationFailed,
    changed,
    log: (error) => console.error('[updates]', error),
  }, unsupportedUpdateReason({
    packaged: app.isPackaged,
    configured: existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    platform: process.platform,
    appImage: Boolean(process.env.APPIMAGE),
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    macDeveloperSigned,
  }));

  const check = () => { void controller.check().catch((error) => console.error('[updates]', error)); };
  // Let the first window and vault screen settle before touching the network.
  const startup = controller.unsupportedReason ? undefined : setTimeout(check, 15_000);
  const periodic = controller.unsupportedReason ? undefined : setInterval(check, 6 * 60 * 60 * 1000);
  startup?.unref();
  periodic?.unref();
  return {
    get menuLabel() { return controller.menuLabel; },
    check: () => { void controller.check(true).catch((error) => console.error('[updates]', error)); },
    stop: () => {
      controller.stop();
      clearTimeout(startup);
      clearInterval(periodic);
    },
  };
}
