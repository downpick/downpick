/**
 * Strips credentials embedded in connection URIs out of free text.
 *
 * The MongoDB driver is built from `mongodb://user:pass@host:port/` (see
 * drivers/mongodb.ts) and quotes that URI back inside its error messages. Those messages
 * flow into `describeError` and from there to both the UI and the log, so a password can
 * escape without ever passing through a field named "password" — field-name-based
 * redaction does not catch it.
 */
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function redactSecrets(text: string): string {
  return text.replace(URI_CREDENTIALS, '$1***:***@');
}
