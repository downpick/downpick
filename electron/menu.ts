import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { EVENTS, MenuCommand } from '../server/channels';

/**
 * The application menu.
 *
 * Menu items do not reach into app state; they send a `menu:command` the renderer routes to
 * the same functions the on-screen buttons call. That keeps one implementation of "run the
 * query" rather than a second one that drifts.
 */

function send(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  window?.webContents.send(EVENTS.menuCommand, command);
}

export function buildMenu(isDev: boolean): void {
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
              click: () => send('settings:open'),
            },
            {
              label: 'AI Providers…',
              accelerator: 'CmdOrCtrl+Shift+,',
              click: () => send('settings:ai'),
            },
            { type: 'separator' },
            {
              label: 'Lock Vault',
              accelerator: 'CmdOrCtrl+L',
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
            click: () => send('settings:open'),
          },
          {
            label: 'AI Providers…',
            accelerator: 'CmdOrCtrl+Shift+,',
            click: () => send('settings:ai'),
          },
          { type: 'separator' },
          {
            label: 'Lock Vault',
            accelerator: 'CmdOrCtrl+L',
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
        click: () => send('query:run'),
      },
      {
        label: 'Run Statement',
        // Unlike Run Query above, F9 IS claimed here. Run Query needs its renderer-side F5
        // listener because the menu already spends its accelerator slot on CmdOrCtrl+Return;
        // this item has only one binding to give, so letting the menu own it means the shortcut
        // shows up next to the label — which is the whole point of putting it here.
        accelerator: 'F9',
        click: () => send('query:runStatement'),
      },
      {
        label: 'Cancel Query',
        accelerator: 'CmdOrCtrl+Shift+Return',
        click: () => send('query:cancel'),
      },
      { type: 'separator' },
      {
        label: 'Format Query',
        accelerator: 'Shift+Alt+F',
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
