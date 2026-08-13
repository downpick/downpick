import { redactSecrets } from '../redact';

/** How long a single model round-trip may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Raised for anything the user can act on: a rejected key, a rate limit, an unreachable
 * endpoint. The message is safe to show verbatim in the panel.
 */
export class AiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiRequestError';
  }
}

/**
 * Validates a user-supplied endpoint.
 *
 * This checks the *shape* of the URL only — scheme, no embedded credentials, no query or
 * fragment. It is explicitly NOT an SSRF control: loopback and private addresses are
 * allowed, because pointing this at `http://localhost:11434/v1` (Ollama) or a LAN inference
 * box is the entire reason the openai_compatible kind exists. The endpoint is typed by the
 * person running the app into their own settings; it never arrives from a query, a schema,
 * or a model response.
 */
export function resolveBaseUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new AiRequestError('This provider needs a base URL.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AiRequestError(`"${trimmed}" is not a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiRequestError('The base URL must start with http:// or https://.');
  }
  if (url.username || url.password) {
    throw new AiRequestError(
      'Put the API key in the API key field rather than embedding it in the base URL.',
    );
  }
  if (url.search || url.hash) {
    throw new AiRequestError('The base URL must not include a query string or fragment.');
  }

  // Normalize to a bare origin+path with no trailing slash, so callers can append
  // "/chat/completions" without producing a double slash.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function describeTransportError(err: unknown, host: string): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `The model did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`;
  }
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not resolve ${host}. Check the base URL.`;
  }
  if (code === 'ECONNREFUSED') {
    return `${host} refused the connection. Is the model server running?`;
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `The TLS certificate for ${host} could not be verified.`;
  }
  return `Could not reach ${host}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`;
}

/**
 * Turns a provider's HTTP error body into one sentence a user can act on. Provider error
 * shapes differ, so this digs for the common ones and falls back to the status code.
 */
function describeHttpError(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const err = parsed.error;
    detail = (typeof err === 'string' ? err : err?.message) ?? parsed.message ?? '';
  } catch {
    detail = body.slice(0, 300);
  }
  detail = redactSecrets(detail.trim());

  if (status === 401 || status === 403) {
    return detail
      ? `The provider rejected the API key: ${detail}`
      : 'The provider rejected the API key. Check it in Settings → AI providers.';
  }
  if (status === 404) {
    return detail || 'The provider returned 404 — check the model id and the base URL.';
  }
  if (status === 429) {
    return detail || 'Rate limited by the provider. Try again in a moment.';
  }
  if (status >= 500) {
    return detail || `The provider returned a ${status} error. Try again in a moment.`;
  }
  return detail || `The provider returned HTTP ${status}.`;
}

async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiRequestError('Cancelled.');
    }
    throw new AiRequestError(describeTransportError(err, host));
  }

  const text = await res.text();
  if (!res.ok) {
    throw new AiRequestError(describeHttpError(res.status, text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiRequestError(`${host} returned a response that was not JSON.`);
  }
}

/** POSTs JSON and parses the JSON response, mapping every failure to an AiRequestError. */
export function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    signal,
  );
}

/** GETs JSON, for the providers' list-models endpoints. */
export function getJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson(url, { method: 'GET', headers }, signal);
}
