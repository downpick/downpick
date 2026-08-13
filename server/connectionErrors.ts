import { DbType } from './connections';
import { redactSecrets } from './redact';

export interface ConnectionErrorContext {
  type: DbType;
  host: string;
  port: number;
  username?: string;
  database?: string;
  // What was being attempted, used only when the failure isn't one of the recognised
  // cases and the message has to fall back to the raw driver text.
  operation?: string;
}

interface ErrorFacts {
  // Every `code`/`codeName` found in the chain, normalized to strings ('ECONNREFUSED', '28P01', '18', …)
  codes: Set<string>;
  names: Set<string>;
  messages: string[];
}

// Driver failures arrive wrapped in wildly different shapes: Node's happy-eyeballs dialer
// rejects with an AggregateError whose own message is empty, tedious nests the real cause in
// `originalError`, and MongoServerSelectionError hides it inside `reason.servers`. Walking the
// whole chain once and collecting the facts lets the mapping below stay driver-agnostic.
function collectFacts(err: unknown, out: ErrorFacts, depth = 0): void {
  if (!err || typeof err !== 'object' || depth > 4) return;
  const e = err as Record<string, unknown>;

  if (typeof e.code === 'string' || typeof e.code === 'number') out.codes.add(String(e.code));
  if (typeof e.codeName === 'string') out.codes.add(e.codeName);
  if (typeof e.name === 'string') out.names.add(e.name);
  if (typeof e.message === 'string' && e.message) out.messages.push(e.message);

  for (const nested of [e.cause, e.originalError, e.reason]) collectFacts(nested, out, depth + 1);
  if (Array.isArray(e.errors)) for (const nested of e.errors) collectFacts(nested, out, depth + 1);

  // MongoServerSelectionError keeps the per-server failure in a Map of ServerDescription.
  const servers = (e.reason as { servers?: unknown } | undefined)?.servers ?? e.servers;
  if (servers instanceof Map) {
    for (const server of servers.values()) {
      collectFacts((server as { error?: unknown } | undefined)?.error, out, depth + 1);
    }
  }
}

function factsOf(err: unknown): ErrorFacts {
  const facts: ErrorFacts = { codes: new Set(), names: new Set(), messages: [] };
  collectFacts(err, facts);
  return facts;
}

// Best raw message available, for the "(detail)" suffix. Falls back to a code or the error
// name when the message is empty — an AggregateError's own message usually is.
//
// Everything here is redacted on the way out: this is the single choke point through which
// raw driver text reaches both the UI and the log, and the MongoDB driver quotes the
// `mongodb://user:pass@host` URI it was built from inside its own messages.
export function describeError(err: unknown): string {
  const facts = factsOf(err);
  const message = facts.messages.find((m) => m.trim().length > 0);
  if (message) return redactSecrets(message.trim());
  const [code] = facts.codes;
  if (code) return redactSecrets(code);
  const [name] = facts.names;
  if (name) return redactSecrets(name);
  return redactSecrets(String(err));
}

const ENGINE_LABEL: Record<DbType, string> = {
  postgres: 'PostgreSQL',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
};

function authHint(ctx: ConnectionErrorContext): string {
  const who = ctx.username ? `user "${ctx.username}"` : 'the connection';
  if (ctx.type === 'mongodb') {
    return ctx.username
      ? `Authentication failed for ${who}. Check the username and password — also make sure the user exists in the "admin" database, which is the authentication database this app uses.`
      : 'The server requires authentication but no username was provided. Add a username and password to this connection.';
  }
  return `Authentication failed for ${who}. Check the username and password.`;
}

/**
 * Turns a raw driver failure into a message worth putting in front of a user: what went wrong,
 * where, and what to check. The original text is kept as a parenthesised detail so nothing is
 * lost when the failure isn't one of the recognised cases.
 */
export function describeConnectionError(err: unknown, ctx: ConnectionErrorContext): string {
  const facts = factsOf(err);
  const raw = describeError(err);
  const lower = facts.messages.join(' | ').toLowerCase();
  const has = (...codes: string[]) => codes.some((c) => facts.codes.has(c));
  const target = `${ctx.host}:${ctx.port}`;
  const engine = ENGINE_LABEL[ctx.type];

  const withDetail = (message: string) => {
    const detail = raw.trim();
    if (!detail || message.toLowerCase().includes(detail.toLowerCase())) return message;
    return `${message} (${detail})`;
  };

  // --- Transport level: identical regardless of which engine is on the other end ---
  if (has('ECONNREFUSED')) {
    return withDetail(
      `Could not reach ${target} — the connection was refused. Check that ${engine} is running and listening on port ${ctx.port}.`,
    );
  }
  if (has('ENOTFOUND', 'EAI_AGAIN')) {
    return withDetail(
      `Host "${ctx.host}" could not be resolved. Check the hostname for typos, or use an IP address.`,
    );
  }
  if (has('EHOSTUNREACH', 'ENETUNREACH')) {
    return withDetail(
      `No network route to ${target}. Check that you are on the right network or VPN.`,
    );
  }
  if (has('ETIMEDOUT', 'ETIMEOUT', 'ESOCKETTIMEDOUT') || lower.includes('server selection timed out')) {
    return withDetail(
      `Timed out connecting to ${target}. The host may be unreachable or a firewall may be dropping the connection — check the host, port, and any VPN or firewall rules.`,
    );
  }
  if (has('ECONNRESET', 'EPIPE')) {
    return withDetail(
      `The connection to ${target} was closed by the server. This often means TLS is required, or the port belongs to a different service.`,
    );
  }
  if (has('ERR_SSL_WRONG_VERSION_NUMBER') || lower.includes('does not support ssl')) {
    return withDetail(`${target} rejected the TLS handshake. The server may not support SSL on this port.`);
  }

  // --- Engine-specific failures ---
  if (ctx.type === 'mongodb') {
    if (has('18', 'AuthenticationFailed') || lower.includes('authentication failed')) {
      return withDetail(authHint(ctx));
    }
    if (has('13', 'Unauthorized') || lower.includes('requires authentication') || lower.includes('not authorized')) {
      return ctx.username
        ? withDetail(
            `User "${ctx.username}" is not authorized for this operation. The user needs the "listDatabases" privilege (for example the "readAnyDatabase" or "clusterMonitor" role) to browse this server.`,
          )
        : withDetail(
            'This server requires authentication. Add a username and password to the connection.',
          );
    }
    if (lower.includes('not primary') || lower.includes('notwritableprimary')) {
      return withDetail(
        `${target} is a replica-set secondary and rejected the request. Connect to the primary instead.`,
      );
    }
    if (facts.names.has('MongoParseError')) {
      return withDetail('The MongoDB connection details are invalid. Check the host, port, and username.');
    }
  }

  if (ctx.type === 'postgres') {
    if (has('28P01', '28000')) return withDetail(authHint(ctx));
    if (has('3D000')) {
      return withDetail(
        ctx.database
          ? `Database "${ctx.database}" does not exist on ${target}.`
          : `The requested database does not exist on ${target}.`,
      );
    }
    if (has('53300')) {
      return withDetail(`${target} has too many open connections and refused a new one.`);
    }
    if (lower.includes('no pg_hba.conf entry')) {
      return withDetail(
        `${target} refused the connection for this client address. The server's pg_hba.conf does not allow it — check the host-based authentication rules.`,
      );
    }
  }

  if (ctx.type === 'sqlserver') {
    if (has('ELOGIN')) return withDetail(authHint(ctx));
    if (has('EINSTLOOKUP')) {
      return withDetail(
        `Could not find the named SQL Server instance on ${ctx.host}. Check the instance name and that the SQL Browser service is running.`,
      );
    }
    if (has('ESOCKET')) {
      return withDetail(
        `Could not open a socket to ${target}. Check that TCP/IP is enabled for this SQL Server instance and that port ${ctx.port} is open.`,
      );
    }
  }

  // Unrecognised — return the raw message rather than inventing an explanation for it.
  return `${ctx.operation ?? `Could not connect to ${engine} at ${target}`}: ${raw}`;
}
