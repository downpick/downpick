import { clipboard } from 'electron';
import { ClipboardWriteRequest } from '../server/channels';
import { AppError, registerHandler } from '../server/dispatch';

/**
 * Puts a result set on the system clipboard.
 *
 * The renderer used to call `navigator.clipboard` directly. That cannot work here: the
 * session's permission handlers deny everything, `clipboard-sanitized-write` included, so
 * the web API rejects every time and the copy button only ever reported failure. Electron's
 * own clipboard needs no permission and writes several formats at once.
 */
export function registerClipboardHandlers(): void {
  registerHandler('clipboard:write', async (request: ClipboardWriteRequest) => {
    const { text, html } = request ?? ({} as ClipboardWriteRequest);
    if (typeof text !== 'string') {
      throw new AppError(400, 'Nothing to copy.');
    }

    // Writing `html` alone would leave anything plain-text-only with an empty paste, so
    // both go in the same call — the target picks the richest flavour it understands.
    clipboard.write(typeof html === 'string' && html ? { text, html } : { text });
    return { ok: true };
  });
}
