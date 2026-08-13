import type { BrowserWindowConstructorOptions, Session, WebContents } from 'electron';
import { shell } from 'electron';

/**
 * Everything that used to be enforced by HTTP headers and the Fastify request gate.
 *
 * The old model defended a loopback port that any local process — or any page the user
 * happened to visit — could try to reach: a per-boot bearer token, a `Host` allowlist against
 * DNS rebinding, and a CORS origin allowlist. None of that has a subject anymore, because
 * nothing listens. What replaces it is the browser sandbox: the renderer can reach exactly
 * the IPC channels the preload exposes, and nothing else.
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'downpick';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Carried over almost verbatim from the Fastify layer.
 *
 * `worker-src`/`child-src blob:` are Monaco's — it creates its editor workers from
 * same-origin /vs URLs and falls back to a blob when the worker URL is not same-origin.
 * `style-src 'unsafe-inline'` is unavoidable while Monaco writes theme rules into
 * `styleElement.textContent` and the resizable panels use React inline styles.
 *
 * `connect-src 'none'` is the one thing that got stricter: the renderer makes no network
 * calls at all now — every request that leaves this machine is made by the main process.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The dev-server equivalent. Vite serves the entry as an inline module script and talks to
 * its HMR websocket, neither of which the production policy allows.
 *
 * Deliberately still a policy rather than no policy: a CSP that only exists in packaged
 * builds is a CSP nobody notices breaking until release.
 */
export function devContentSecurityPolicy(devServer: string): string {
  const { origin } = new URL(devServer);
  const ws = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${origin}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${origin} ${ws}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Applied to every response the app protocol serves, alongside the CSP. */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * The renderer runs with no Node access whatsoever: `sandbox` puts it in a real Chromium
 * sandbox, `contextIsolation` keeps the preload's world separate from the page's, and
 * `nodeIntegration: false` means `require` and `process` are simply absent.
 */
export const WEB_PREFERENCES: BrowserWindowConstructorOptions['webPreferences'] = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
};

/**
 * Pins a window to its own origin.
 *
 * There is nothing in this app a user should be able to navigate to — no external links, no
 * OAuth popup, no docs pane. AI provider endpoints are fetched by the main process and never
 * loaded into a window, so anything trying to navigate here is either a bug or an injection.
 */
export function hardenWebContents(contents: WebContents, allowedOrigin: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    // Hand genuine web links to the user's real browser rather than opening a second,
    // less-locked-down window. Anything else is refused outright.
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${allowedOrigin}/`) && url !== allowedOrigin) {
      event.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/** The app asks for no device permissions, so every request is a request it did not make. */
export function installPermissionHandlers(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
