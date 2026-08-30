/// <reference types="vite/client" />

import type {
  AiChatEvent,
  Channel,
  Envelope,
  MenuCommand,
  NotificationActivateEvent,
  SaveFileRequest,
  SaveFileResult,
} from '../../server/channels';

declare global {
  interface Window {
    /**
     * The bridge exposed by electron/preload.ts — the renderer's only way to reach anything
     * outside the page. Shaped by the same types the main process uses, so a channel renamed
     * on one side stops compiling on the other.
     */
    downpick: {
      invoke<T>(channel: Channel, payload?: unknown): Promise<Envelope<T>>;
      saveFile(request: SaveFileRequest): Promise<Envelope<SaveFileResult>>;
      onAiChat(listener: (payload: AiChatEvent) => void): () => void;
      onMenuCommand(listener: (command: MenuCommand) => void): () => void;
      onQueryNotificationClick(
        listener: (payload: NotificationActivateEvent) => void,
      ): () => void;
    };
  }
}

export {};
