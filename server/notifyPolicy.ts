import { NotifyResult, QueryFinishedNotice } from './channels';
import { AppSettings } from './settings';

/**
 * What the window is doing at the moment a query comes back.
 *
 * `null` when there is no window at all — a race the teardown path can produce, and the one
 * case where there is nobody to send a click back to.
 */
export interface WindowPresence {
  /** True only when the window is on screen AND is the one the user is working in. */
  inFront: boolean;
}

/**
 * Whether a finished query is worth announcing, and how.
 *
 * Pure, and deliberately kept out of `electron/notifications.ts`: this is the rule, and it is
 * the part worth asserting. The Electron module around it only reads the window state and
 * draws the result.
 *
 * The shape of the rule:
 *  - off → nothing;
 *  - too quick to be worth interrupting for → nothing, unless it timed out;
 *  - the user is already looking at the window → the in-app toast, because a desktop banner
 *    over the answer they are reading is noise;
 *  - otherwise → the desktop, which is the whole point: they walked away.
 *
 * With no window to activate, or on a platform with no notifications, the toast is the honest
 * fallback: it waits on screen for whenever the user does come back.
 */
export function decideNotification(
  notice: Pick<QueryFinishedNotice, 'elapsedMs' | 'outcome'>,
  settings: Pick<AppSettings, 'notifyOnQueryFinish' | 'notifyAfterSeconds'>,
  presence: WindowPresence | null,
  /** Whether the platform can show a desktop notification at all. */
  notificationsSupported: boolean,
): NotifyResult['shown'] {
  if (!settings.notifyOnQueryFinish) return 'none';

  // The threshold asks "did this come back fast enough that you never looked away?" — a
  // question that does not apply to a query that never came back at all. A timeout is an
  // abnormal end, under a limit the user set themselves, and swallowing it because the limit
  // happened to be shorter than this threshold would make two unrelated settings interact
  // silently: a 5s query timeout under a 10s threshold would never announce anything.
  if (notice.outcome !== 'timeout') {
    const elapsedMs = notice.elapsedMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs < settings.notifyAfterSeconds * 1000) {
      return 'none';
    }
  }

  // No window means nothing to bring forward when the notification is clicked, so there is
  // no native notification worth showing either.
  if (!presence || presence.inFront) return 'toast';
  return notificationsSupported ? 'native' : 'toast';
}
