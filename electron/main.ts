import { app, BrowserWindow, nativeImage, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { bootstrap, getVaultStatus, onVaultStatusChange, shutdown } from '../server/bootstrap';
import { APP_USER_MODEL_ID } from './appId';
import { attachAiStream, registerIpc } from './ipc';
import { buildMenu } from './menu';
import { registerAppProtocol, registerAppScheme } from './protocol';
import {
  APP_ORIGIN,
  devContentSecurityPolicy,
  hardenWebContents,
  installPermissionHandlers,
  WEB_PREFERENCES,
} from './security';
import { loadWindowState, trackWindowState } from './windowState';

/**
 * Where the renderer comes from.
 *
 * `--dev-server=<url>` points the window at Vite for hot reload; without it the window loads
 * the built client over the app:// protocol. The flag is ignored in a packaged build on
 * purpose — otherwise a shortcut with an extra argument could aim a shipped app at an
 * arbitrary origin and inherit the relaxed dev CSP along with it.
 */
function devServerUrl(): string | null {
  if (app.isPackaged) return null;
  const flag = process.argv.find((arg) => arg.startsWith('--dev-server='));
  return flag ? flag.slice('--dev-server='.length) : null;
}

const DEV_SERVER = devServerUrl();

/**
 * The name shown in the dock, the macOS menu bar, and the window list.
 *
 * Without this, an unpackaged run falls back to the lowercase `name` in package.json, and the
 * macOS application menu reads "downpick". A packaged build takes its name from the bundle's
 * Info.plist instead, so this only changes what developers see — but it also pins
 * `app.getPath('userData')` to the same directory both ways, which keeps the renderer's
 * localStorage (restored tabs, panel sizes) from splitting in two on case-sensitive
 * filesystems. Must run before anything reads a path or the name.
 */
app.setName('Downpick');

/**
 * The identity Windows files this app's toast notifications under.
 *
 * Windows will not raise a toast for a desktop app it cannot tie to a Start Menu shortcut
 * carrying the same AppUserModelID. Electron sets one by itself only when it detects
 * Squirrel; this app ships an NSIS installer and a portable build, so neither gets it for
 * free and the notifications the query-finished feature sends would arrive unattributed —
 * or not at all.
 *
 * The value lives in appId.ts, where a test holds it against `appId` in electron-builder.yml
 * — the string the installer stamps onto the shortcut. Windows compares the two verbatim.
 *
 * No-op on macOS and Linux, so it is called unconditionally rather than behind a platform
 * branch. Set here with `setName`, before any window exists — Windows reads it when the
 * first notification is raised, and a BrowserWindow opened beforehand would already have
 * inherited the default.
 */
app.setAppUserModelId(APP_USER_MODEL_ID);

/**
 * The app icon as a file on disk.
 *
 * Only needed where the OS cannot get it from somewhere better: a packaged macOS build uses
 * the .icns in its bundle and a packaged Windows build uses the icon compiled into the exe,
 * but an unpackaged run has neither and would otherwise show Electron's own.
 */
function appIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.png'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

// Must happen before `whenReady`, and only matters when the app:// protocol will be used.
if (!DEV_SERVER) registerAppScheme();

function createWindow(): BrowserWindow {
  const state = loadWindowState();
  const icon = appIconPath();

  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Downpick',
    // The app draws no titlebar of its own, so on macOS the frame is hidden and the
    // traffic lights float over the drag strip the renderer reserves at the top of the
    // sidebar. Windows and Linux keep the standard frame — the menu bar renders there.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    // Windows and Linux take the taskbar icon from the window. macOS ignores this entirely
    // and uses the dock icon, which is set once at startup below.
    ...(process.platform !== 'darwin' && icon ? { icon } : {}),
    webPreferences: {
      ...WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (state.maximized) window.maximize();
  trackWindowState(window);
  hardenWebContents(window.webContents, DEV_SERVER ? new URL(DEV_SERVER).origin : APP_ORIGIN);
  attachAiStream(window.webContents);

  // Painting only once the renderer is ready avoids the white flash before the dark theme
  // and the vault dialog appear.
  window.once('ready-to-show', () => window.show());

  if (DEV_SERVER) {
    void window.loadURL(DEV_SERVER);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  return window;
}

/**
 * The dev server is plain HTTP, so its CSP has to be injected on the way through — the
 * app:// handler sets its own headers directly on each response instead.
 */
function installDevCsp(): void {
  if (!DEV_SERVER) return;
  const policy = devContentSecurityPolicy(DEV_SERVER);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

// A second launch should raise the window that is already open rather than start a rival
// process: two instances would fight over the same vault file and its write sequence.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(() => {
    // Everything the handlers need — vault path, auto-lock, the lock→disconnect wiring —
    // has to exist before the first IPC call can arrive.
    bootstrap();
    registerIpc();

    installPermissionHandlers(session.defaultSession);
    installDevCsp();
    if (!DEV_SERVER) registerAppProtocol();

    // Rebuilt on every lock/unlock so the vault-gated items are greyed out while the vault
    // is shut. Driven from the store rather than from the renderer because the idle
    // auto-lock fires in this process, and the renderer does not find out about it until
    // some later call comes back 423.
    const refreshMenu = (status: { initialized: boolean; locked: boolean }) =>
      buildMenu(Boolean(DEV_SERVER), status.initialized && !status.locked);
    onVaultStatusChange(refreshMenu);
    refreshMenu(getVaultStatus());

    // macOS reads the dock icon from the running bundle, which unpackaged means Electron's
    // own. A packaged build already carries the right .icns, so this is a no-op there —
    // setting it unconditionally just avoids a branch that would only ever be exercised in
    // one of the two modes.
    const icon = appIconPath();
    if (process.platform === 'darwin' && icon && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(icon));
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention is to stay resident, but a database client with no window is holding
    // open connections nobody can see or cancel. Quitting keeps that honest on every platform.
    app.quit();
  });

  let teardownDone = false;
  app.on('before-quit', (event) => {
    if (teardownDone) return;
    event.preventDefault();

    // `before-quit` does not await an async listener, hence the re-entry flag. The race is
    // deliberate: a pool wedged on an unresponsive server must not make the app unquittable,
    // so whichever finishes first wins and the process exits either way.
    const deadline = new Promise((resolve) => setTimeout(resolve, 2000));
    void Promise.race([shutdown().catch(() => {}), deadline]).then(() => {
      teardownDone = true;
      app.quit();
    });
  });
}
