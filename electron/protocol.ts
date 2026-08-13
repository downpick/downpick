import { net, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { APP_HOST, APP_SCHEME, CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from './security';

/**
 * Serves the built renderer from `app://downpick/`.
 *
 * A custom scheme rather than `file://` because the app needs a real origin: `localStorage`
 * (restored tabs, panel sizes) is keyed to one, and `file://` has none.
 */

/**
 * Must run before `app.whenReady()`.
 *
 * `standard` is what gives the scheme an origin at all; `secure` puts it in a secure context,
 * which several web APIs gate on. `supportFetchAPI` lets Monaco's loader pull its language
 * workers the same way it would over http.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/**
 * The built renderer, both unpackaged and inside the asar.
 *
 * `__dirname` is `<root>/.electron-out/electron` either way — the asar just prefixes it —
 * so one relative hop covers both. The extra candidates only matter if someone runs the
 * compiled output from an unusual cwd.
 */
export function findClientDist(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'client', 'dist'),
    path.join(process.cwd(), 'client', 'dist'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function decorate(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { ...SECURITY_HEADERS, 'Content-Security-Policy': CONTENT_SECURITY_POLICY },
  });
}

/**
 * Maps a request URL to a file under `root`, refusing anything that escapes it.
 *
 * Returns null when the request must be rejected. The decode happens *first* on purpose: a
 * traversal encoded as `%2e%2e%2f` walks straight past a check performed on the raw string.
 */
export function resolveRequestPath(requestUrl: string, root: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    // Malformed percent-encoding. Nothing legitimate produces this.
    return null;
  }

  if (pathname === '' || pathname === '/') pathname = '/index.html';

  // normalize() collapses the `..` segments; resolve() then produces an absolute path that
  // the containment check below can be made against. Both are needed — normalize alone is
  // not a security boundary, and on Windows it does not treat `\` as a separator.
  const resolved = path.resolve(root, `.${path.posix.normalize(pathname)}`);
  const bounded = resolved === root || resolved.startsWith(root + path.sep);
  return bounded ? resolved : null;
}

/**
 * Decides what a path that is not a real file should return.
 *
 * A navigation route ("/settings") gets the SPA shell. An asset request that misses gets a
 * real 404 — serving index.html there would hand the browser HTML to parse as JavaScript,
 * which fails in a way that looks nothing like the missing file it actually is.
 */
export function isNavigationRequest(filePath: string): boolean {
  return !path.basename(filePath).includes('.');
}

export function registerAppProtocol(): void {
  const root = path.resolve(findClientDist());
  const indexHtml = path.join(root, 'index.html');

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return notFound('Unknown host');

    const resolved = resolveRequestPath(request.url, root);
    if (!resolved) return notFound('Forbidden path');

    let target = resolved;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (!isNavigationRequest(resolved)) return notFound('Asset not found');
      target = indexHtml;
    }

    // net.fetch over a file URL streams the body and infers Content-Type from the extension.
    // Hand-rolling that means hand-rolling a MIME table, and one wrong entry — `/vs/loader.js`
    // served as text/plain — silently breaks Monaco's whole worker tree.
    return decorate(await net.fetch(pathToFileURL(target).toString()));
  });
}
