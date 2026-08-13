import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  APP_ORIGIN,
  CONTENT_SECURITY_POLICY,
  devContentSecurityPolicy,
  SECURITY_HEADERS,
  WEB_PREFERENCES,
} from './security';
import { isNavigationRequest, resolveRequestPath } from './protocol';

/**
 * These replace the HTTP-layer tests that went away with Fastify — the bearer token, the
 * `Host` allowlist, the CORS origin check, and the CSP response header. Three of those four
 * defended a listening port that no longer exists; what is left still has to be asserted
 * somewhere, so it is asserted here.
 */

test('the renderer runs with no path to Node', () => {
  assert.equal(WEB_PREFERENCES?.contextIsolation, true);
  assert.equal(WEB_PREFERENCES?.nodeIntegration, false);
  assert.equal(WEB_PREFERENCES?.nodeIntegrationInWorker, false);
  assert.equal(WEB_PREFERENCES?.sandbox, true);
  assert.equal(WEB_PREFERENCES?.webSecurity, true);
  assert.equal(WEB_PREFERENCES?.webviewTag, false);
});

test('the production CSP is at least as strict as the one the server used to send', () => {
  const csp = CONTENT_SECURITY_POLICY;
  assert.ok(!csp.includes('unsafe-eval'), 'Monaco degrades gracefully; unsafe-eval is not needed');
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'inline script must stay blocked');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  // Monaco creates its editor workers from same-origin /vs URLs, with a blob: fallback.
  assert.match(csp, /worker-src 'self' blob:/);
  // Tighter than the HTTP build: the renderer has no reason to reach the network at all.
  assert.match(csp, /connect-src 'none'/);
});

test('the dev CSP relaxes only what Vite needs, and only for Vite', () => {
  const csp = devContentSecurityPolicy('http://localhost:5173');
  assert.match(csp, /script-src [^;]*'unsafe-inline'/, 'Vite serves the entry inline');
  assert.match(csp, /connect-src [^;]*ws:\/\/localhost:5173/, 'HMR needs its socket');
  // The relaxation must not become a blanket allow.
  assert.ok(!csp.includes('unsafe-eval'));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test('every response still carries the hardening headers', () => {
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('the protocol handler refuses to serve anything outside the client build', () => {
  const root = path.resolve('/app/client/dist');

  for (const attempt of [
    '/../../package.json',
    '/../../../etc/passwd',
    // Percent-encoded, which is the whole reason the decode happens before the check.
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/assets/..%2f..%2f..%2fetc%2fpasswd',
  ]) {
    const resolved = resolveRequestPath(`${APP_ORIGIN}${attempt}`, root);
    if (resolved !== null) {
      assert.ok(
        resolved === root || resolved.startsWith(root + path.sep),
        `${attempt} escaped the client build root (resolved to ${resolved})`,
      );
    }
  }

  // Malformed percent-encoding is refused outright rather than passed through raw.
  assert.equal(resolveRequestPath(`${APP_ORIGIN}/%zz`, root), null);
});

test('the protocol handler serves real files from inside the root', () => {
  const root = path.resolve('/app/client/dist');
  assert.equal(resolveRequestPath(`${APP_ORIGIN}/index.html`, root), path.join(root, 'index.html'));
  assert.equal(resolveRequestPath(`${APP_ORIGIN}/`, root), path.join(root, 'index.html'));
  assert.equal(
    resolveRequestPath(`${APP_ORIGIN}/vs/loader.js`, root),
    path.join(root, 'vs', 'loader.js'),
  );
});

test('a missing asset is a 404 while a missing route is the SPA shell', () => {
  // Serving index.html for a missing .js would hand the browser HTML to parse as JavaScript,
  // which fails in a way that looks nothing like the missing file it actually is.
  assert.equal(isNavigationRequest('/app/client/dist/vs/loader.js'), false);
  assert.equal(isNavigationRequest('/app/client/dist/assets/index-a1b2c3.css'), false);
  assert.equal(isNavigationRequest('/app/client/dist/settings'), true);
});
