import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { EVENTS, MenuCommand } from '../server/channels';

/**
 * The application menu.
 *
 * Menu items do not reach into app state; they send a `menu:command` the renderer routes to
 * the same functions the on-screen buttons call. That keeps one implementation of "run the
 * query" rather than a second one that drifts.
 *
 * Everything that only makes sense behind an open vault is disabled while the vault is
 * locked or has not been created yet. Not cosmetic: the renderer's command listener sits
 * above its lock gate, so a `settings:open` arriving while locked used to flip the dialog on
 * in a store nobody was rendering — and the Settings dialog was then already open the moment
 * the user unlocked. Disabling also takes the accelerator out of play, which is why the Edit
 * menu is deliberately left alone: the unlock screen's password field needs paste.
 *
 * The whole menu is rebuilt on each change rather than toggling `enabled` by id — this
 * function is a pure function of its two arguments, and keeping it that way is cheaper to
 * reason about than a second code path that mutates the live menu.
 */

function send(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(EVENTS.menuCommand, command);
}

export function buildMenu(isDev: boolean, vaultUnlocked: boolean): void {
  const isMac = process.platform === 'darwin';

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              label: 'Settings…',
              accelerator: 'CmdOrCtrl+,',
              enabled: vaultUnlocked,
              click: () => send('settings:open'),
            },
            {
              label: 'AI Providers…',
              accelerator: 'CmdOrCtrl+Shift+,',
              enabled: vaultUnlocked,
              click: () => send('settings:ai'),
            },
            { type: 'separator' },
            {
              label: 'Lock Vault',
              accelerator: 'CmdOrCtrl+L',
              enabled: vaultUnlocked,
              click: () => send('vault:lock'),
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  // New Connection lives here on every platform. Settings and AI Providers only appear
  // here off macOS, where there is no app menu to hold them.
  const newConnectionItem: MenuItemConstructorOptions = {
    label: 'New Connection…',
    accelerator: 'CmdOrCtrl+N',
    enabled: vaultUnlocked,
    click: () => send('connection:new'),
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: '&File',
    submenu: isMac
      ? [newConnectionItem, { type: 'separator' }, { role: 'close' }]
      : [
          newConnectionItem,
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            enabled: vaultUnlocked,
            click: () => send('settings:open'),
          },
          {
            label: 'AI Providers…',
            accelerator: 'CmdOrCtrl+Shift+,',
            enabled: vaultUnlocked,
            click: () => send('settings:ai'),
          },
          { type: 'separator' },
          {
            label: 'Lock Vault',
            accelerator: 'CmdOrCtrl+L',
            enabled: vaultUnlocked,
            click: () => send('vault:lock'),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
  };

  // Standard roles rather than custom handlers: Monaco relies on the native clipboard
  // actions, and a hand-rolled copy would not reach the editor's own selection model.
  const editMenu: MenuItemConstructorOptions = {
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  };

  const queryMenu: MenuItemConstructorOptions = {
    label: '&Query',
    submenu: [
      {
        label: 'Run Query',
        // F5 stays unclaimed here on purpose: the renderer already binds it window-wide, and
        // an accelerator would swallow the key before that listener ever saw it.
        accelerator: 'CmdOrCtrl+Return',
        enabled: vaultUnlocked,
        click: () => send('query:run'),
      },
      {
        label: 'Run Statement',
        // Unlike Run Query above, F9 IS claimed here. Run Query needs its renderer-side F5
        // listener because the menu already spends its accelerator slot on CmdOrCtrl+Return;
        // this item has only one binding to give, so letting the menu own it means the shortcut
        // shows up next to the label — which is the whole point of putting it here.
        accelerator: 'F9',
        enabled: vaultUnlocked,
        click: () => send('query:runStatement'),
      },
      {
        label: 'Cancel Query',
        accelerator: 'CmdOrCtrl+Shift+Return',
        enabled: vaultUnlocked,
        click: () => send('query:cancel'),
      },
      { type: 'separator' },
      {
        label: 'Format Query',
        accelerator: 'Shift+Alt+F',
        enabled: vaultUnlocked,
        click: () => send('query:format'),
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: '&View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: '&Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'Downpick on GitHub',
        click: () => void shell.openExternal('https://github.com/'),
      },
    ],
  };

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...appMenu,
      fileMenu,
      editMenu,
      queryMenu,
      viewMenu,
      windowMenu,
      helpMenu,
    ]),
  );
}
