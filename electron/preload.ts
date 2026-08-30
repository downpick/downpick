import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiChatEvent,
  Channel,
  Envelope,
  EVENTS,
  IPC_INVOKE,
  MenuCommand,
  NotificationActivateEvent,
  SaveFileRequest,
  SaveFileResult,
} from '../server/channels';

/**
 * The entire surface the renderer gets. Nothing else crosses.
 *
 * Every import above is `import type`, which compiles to nothing. That is deliberate: this
 * script runs in a *sandboxed* preload, where `require` resolves only Electron's own built-in
 * modules — a real import of `../server/channels` would fail at load. The constants below are
 * therefore written as literals, but typed against the shared definitions, so changing a name
 * in channels.ts breaks this file at compile time instead of at runtime.
 */
const INVOKE: typeof IPC_INVOKE = 'downpick:invoke';
const AI_CHAT_EVENT: (typeof EVENTS)['aiChat'] = 'ai:chat:event';
const MENU_COMMAND_EVENT: (typeof EVENTS)['menuCommand'] = 'menu:command';
const NOTIFICATION_ACTIVATE_EVENT: (typeof EVENTS)['notificationActivate'] =
  'notification:activate';

export interface DownpickBridge {
  invoke<T>(channel: Channel, payload?: unknown): Promise<Envelope<T>>;
  saveFile(request: SaveFileRequest): Promise<Envelope<SaveFileResult>>;
  onAiChat(listener: (payload: AiChatEvent) => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onQueryNotificationClick(listener: (payload: NotificationActivateEvent) => void): () => void;
}

/** Wraps `ipcRenderer.on` so callers get an unsubscribe rather than having to mirror the args. */
function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => listener(payload);
  ipcRenderer.on(event, handler);
  return () => {
    ipcRenderer.off(event, handler);
  };
}

const bridge: DownpickBridge = {
  invoke: (channel, payload) => ipcRenderer.invoke(INVOKE, channel, payload),
  saveFile: (request) => ipcRenderer.invoke(INVOKE, 'files:save', request),
  onAiChat: (listener) => subscribe(AI_CHAT_EVENT, listener),
  onMenuCommand: (listener) => subscribe(MENU_COMMAND_EVENT, listener),
  onQueryNotificationClick: (listener) => subscribe(NOTIFICATION_ACTIVATE_EVENT, listener),
};

contextBridge.exposeInMainWorld('downpick', bridge);
