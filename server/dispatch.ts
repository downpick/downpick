import { Channel, Envelope, isChannel, UNLOCKED_NOT_REQUIRED } from './channels';
import { redactSecrets } from './redact';
import * as vault from './vault/store';

/**
 * The single choke point every renderer call passes through — what the Fastify instance
 * used to be.
 *
 * `electron/ipc.ts` wraps this in a one-line `ipcMain.handle`, which is the only reason it
 * takes plain values instead of an Electron event: the core stays drivable from `node:test`
 * without booting an app.
 */

/**
 * An expected failure with an HTTP-style status, replacing `reply.status(n).send({error})`.
 *
 * The status codes are kept even though nothing speaks HTTP anymore: the renderer already
 * branches on 423 to raise the unlock dialog, and 401/404/409/422 carry meaning the UI
 * relies on. Inventing a parallel vocabulary would only mean translating twice.
 */
export class AppError extends Error {
  readonly status: number;
  /** 1-based line in the submitted SQL, when the driver could pin the error to one. */
  readonly line?: number;
  /**
   * A stable machine-readable tag for the failures the UI has to tell apart from each other.
   *
   * The message alone is not enough: a query the timeout cancelled and a query the server
   * rejected both arrive as a 400, and the only thing separating them was the wording of a
   * string the UI would have had to pattern-match. See `QUERY_TIMEOUT` in channels.ts.
   */
  readonly code?: string;

  constructor(status: number, message: string, line?: number, code?: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.line = line;
    this.code = code;
  }
}

export type Handler = (payload: any) => unknown | Promise<unknown>;

const handlers = new Map<Channel, Handler>();

export function registerHandler(channel: Channel, handler: Handler): void {
  handlers.set(channel, handler);
}

/** Test hook — lets a suite assert the wiring is complete without booting Electron. */
export function registeredChannels(): Channel[] {
  return [...handlers.keys()];
}

/**
 * Reproduces the serialization the HTTP layer used to apply for free.
 *
 * IPC uses structured clone, which is *more* faithful than JSON: it preserves `Date` objects
 * and turns `Buffer` into `Uint8Array`. That is exactly wrong here, because the renderer was
 * written against `JSON.stringify` output — `ResultsGrid.exportXlsx` tests values with
 * `/^\d{4}-\d{2}-\d{2}T/` to spot timestamps, which a live Date silently fails. Round-tripping
 * through JSON keeps every driver's results in the shape the UI already parses, and invokes
 * the `toJSON()` methods (Date, Buffer) the old wire format depended on.
 */
function toWire<T>(value: T): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function describe(err: unknown): { status: number; error: string; line?: number; code?: string } {
  if (err instanceof AppError) {
    return { status: err.status, error: err.message, line: err.line, code: err.code };
  }
  // Anything unplanned. Redacted because driver errors quote the connection URI they were
  // built from, password and all (see redact.ts).
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, error: redactSecrets(message) };
}

/**
 * Routes one call: channel allowlist, vault gate, handler, envelope.
 *
 * Every failure comes back as `{ ok: false }` rather than a rejected promise — see the
 * comment on `Envelope`.
 */
export async function dispatch(channel: string, payload?: unknown): Promise<Envelope<unknown>> {
  if (!isChannel(channel)) {
    return { ok: false, status: 404, error: `Unknown channel: ${String(channel)}` };
  }

  const handler = handlers.get(channel);
  if (!handler) {
    return { ok: false, status: 500, error: `No handler registered for ${channel}` };
  }

  // The vault gate, moved off the Fastify onRequest hook. Same rule as before: everything
  // outside the allowlist is refused while locked.
  if (!UNLOCKED_NOT_REQUIRED.includes(channel)) {
    if (vault.isLocked()) {
      return { ok: false, status: 423, error: 'The vault is locked.' };
    }
    // Idle auto-lock is measured from API activity, not UI activity: an eight-minute query
    // is not idleness, and locking mid-flight would close the driver still running it.
    vault.touch();
  }

  try {
    return { ok: true, data: toWire(await handler(payload ?? {})) };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}
