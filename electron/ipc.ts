import { ipcMain, WebContents } from 'electron';
import { AiChatEvent, EVENTS, IPC_INVOKE } from '../server/channels';
import { dispatch } from '../server/dispatch';
import { cancelAllAiStreams, setAiStreamEmitter } from '../server/handlers/ai';
import { registerClipboardHandlers } from './clipboard';
import { registerFileHandlers } from './files';
import { registerNotificationHandlers } from './notifications';

/**
 * The whole main↔renderer bridge: one `handle` that forwards to the core dispatcher, plus
 * the push channel the AI panel streams over.
 *
 * The dispatcher is what validates the channel name and enforces the vault gate, so this
 * layer stays deliberately dumb — it must not grow a second way into the handlers.
 */
export function registerIpc(): void {
  registerFileHandlers();
  registerClipboardHandlers();
  registerNotificationHandlers();

  ipcMain.handle(IPC_INVOKE, async (_event, channel: string, payload: unknown) =>
    // Note the absence of a try/catch: `dispatch` returns failures as envelopes rather than
    // rejecting, precisely so Electron never gets a chance to rewrite the message into
    // "Error invoking remote method ...".
    dispatch(channel, payload),
  );
}

/**
 * Points AI answer events at a window.
 *
 * The core has no idea what a webContents is; it just calls the emitter it was given. This
 * also means a destroyed window silently stops receiving, rather than throwing from inside
 * the agent loop.
 */
export function attachAiStream(contents: WebContents): void {
  setAiStreamEmitter((payload: AiChatEvent) => {
    if (!contents.isDestroyed()) contents.send(EVENTS.aiChat, payload);
  });

  contents.once('destroyed', () => {
    setAiStreamEmitter(() => {});
    // Nothing is listening for these answers anymore, and each one is holding an open
    // request to a provider.
    cancelAllAiStreams();
  });
}
