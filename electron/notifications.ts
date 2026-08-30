import { BrowserWindow, Notification } from 'electron';
import {
  EVENTS,
  NotifyResult,
  QueryFinishedNotice,
  TestNotificationResult,
} from '../server/channels';
import { AppError, registerHandler } from '../server/dispatch';
import { decideNotification } from '../server/notifyPolicy';
import { loadSettings } from '../server/settings';

/**
 * Announces a finished query.
 *
 * This lives in main for the same reason `clipboard:write` does: the session's permission
 * handlers deny everything, so a `new Notification(...)` in the renderer would never be
 * allowed to show. Electron's own `Notification` is a main-process API and needs no
 * permission from us — only the OS-level one the user grants the app, which is outside our
 * reach either way.
 *
 * Main also owns the *decision*, not just the drawing, because both of its inputs live here:
 * the threshold in settings.json, and whether this window is the one the user is looking at.
 * The renderer could answer neither honestly — `document.hasFocus()` is about the document,
 * not about which application is in front — so it is told only what it still has to do. The
 * rule itself is `decideNotification`; what is left here is reading the window and drawing.
 */
export function registerNotificationHandlers(): void {
  registerHandler('notify:queryFinished', (notice: QueryFinishedNotice): NotifyResult => {
    const { tabId, outcome, connectionName, database, detail } =
      notice ?? ({} as QueryFinishedNotice);
    if (!tabId || (outcome !== 'success' && outcome !== 'timeout')) {
      throw new AppError(400, 'tabId and a valid outcome are required');
    }

    const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const presence = window
      ? { inFront: window.isVisible() && !window.isMinimized() && window.isFocused() }
      : null;

    // Read per call rather than cached, exactly like the query timeout: a change in Settings
    // applies to the next query with no restart.
    const shown = decideNotification(notice, loadSettings(), presence, Notification.isSupported());
    if (shown !== 'native' || !window) return { shown };

    const notification = new Notification({
      title: outcome === 'timeout' ? 'Query timed out' : 'Query finished',
      body: `${connectionName} · ${database}\n${detail}`,
    });

    notification.once('click', () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      // The tab may well have been closed while the query ran; the renderer checks before
      // acting, so this stays a plain "here is where it came from".
      window.webContents.send(EVENTS.notificationActivate, { tabId });
    });

    notification.show();
    return { shown };
  });

  /**
   * Raise a notification on demand, from the button in Settings.
   *
   * Deliberately ignores both the enable switch and the threshold: this is the user asking
   * "can this app reach my desktop at all", and the honest way to answer is to try. It also
   * never falls back to the in-app toast the way a finished query does — a toast would prove
   * nothing about the permission being tested, since the window is in front by definition
   * when someone is clicking a button in it.
   */
  registerHandler('notify:test', (): TestNotificationResult => {
    if (!Notification.isSupported()) return { supported: false, sent: false };

    new Notification({
      title: 'Downpick notifications are working',
      body: 'This is what a finished query will look like.',
    }).show();

    return { supported: true, sent: true };
  });
}
