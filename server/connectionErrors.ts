import { DbType } from './connections';
import { redactSecrets } from './redact';

export interface ConnectionErrorContext {
  type: DbType;
  host: string;
  port: number;
  username?: string;
  database?: string;
  /** Oracle only — quoted back in the ORA-12514 message, which is a question about this field. */
  serviceName?: string;
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
  // node-oracledb puts the number in `errorNum` rather than `code`. Normalising it to the same
  // "ORA-01017" spelling its own message uses lets the Oracle mapping below read like the others
  // — has('ORA-01017') — instead of carrying a numeric special case.
  if (typeof e.errorNum === 'number' && e.errorNum > 0) {
    out.codes.add(`ORA-${String(e.errorNum).padStart(5, '0')}`);
  }
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
  oracle: 'Oracle',
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
  //
  // Both a collected code and the message text are checked. node-oracledb wraps a refused socket
  // as `code: 'NJS-503'` with no nested cause and the errno only in its message, so a code-only
  // test misses the single most common failure there is and falls through to the raw dump.
  if (has('ECONNREFUSED') || lower.includes('econnrefused')) {
    return withDetail(
      `Could not reach ${target} — the connection was refused. Check that ${engine} is running and listening on port ${ctx.port}.`,
    );
  }
  if (has('ENOTFOUND', 'EAI_AGAIN') || lower.includes('enotfound') || lower.includes('eai_again')) {
    return withDetail(
      `Host "${ctx.host}" could not be resolved. Check the hostname for typos, or use an IP address.`,
    );
  }
  if (has('EHOSTUNREACH', 'ENETUNREACH') || lower.includes('ehostunreach') || lower.includes('enetunreach')) {
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

  if (ctx.type === 'oracle') {
    // ORA-28002 ("the password will expire within N days") deliberately has no entry: it arrives
    // on a SUCCESSFUL connect, and mapping it here would turn a warning into an error the user
    // cannot get past. DPI-1047 ("cannot locate Oracle Client library") is likewise unmapped — it
    // can only be raised in Thick mode, which drivers/oracle.ts never enables, so if it ever
    // appears the Thin-mode rule in that file has been broken and the raw text is the right clue.
    if (has('ORA-01017')) return withDetail(authHint(ctx));
    if (has('ORA-28000')) {
      return withDetail(
        `The Oracle account "${ctx.username}" is locked. A DBA can unlock it with ALTER USER ${ctx.username} ACCOUNT UNLOCK.`,
      );
    }
    if (has('ORA-28001')) {
      return withDetail(
        `The password for "${ctx.username}" has expired. It must be changed in Oracle before this connection will work — retyping the old one will not help.`,
      );
    }
    // The most common Oracle-specific mistake, and the reason Service Name is its own field.
    //
    // BOTH spellings are needed. ORA-12514 is what the listener returns through the Oracle
    // client; Thin mode does its own service resolution and reports NJS-518 instead, so an
    // ORA-only test would never fire for the connections this app actually makes.
    if (has('ORA-12514', 'NJS-518') || lower.includes('is not registered with the listener')) {
      const service = ctx.serviceName ?? ctx.database;
      return withDetail(
        `The Oracle listener at ${target} is running but does not serve ${service ? `"${service}"` : 'that service'}. Check the Service Name — it is not the SID, and "lsnrctl status" on the server lists the services the listener actually knows about.`,
      );
    }
    if (has('ORA-12505')) {
      return withDetail(
        `The listener at ${target} knows no SID by that name. Downpick connects with a service name rather than a SID; if this database registers only a SID, it needs a listener entry exposing it as a service.`,
      );
    }
    if (has('ORA-12541')) {
      return withDetail(
        `No Oracle listener is answering on ${target}. Check that the listener is running and that ${ctx.port} is its port — 1521 is the default.`,
      );
    }
    if (has('ORA-12516', 'ORA-12518', 'ORA-12520')) {
      return withDetail(
        `The listener at ${target} has no server process available. The database may be starting up, in restricted mode, or out of processes.`,
      );
    }
    if (has('ORA-12170')) {
      return withDetail(
        `Timed out connecting to ${target}. The host may be unreachable or a firewall may be dropping the connection.`,
      );
    }
    if (has('ORA-12154')) {
      return withDetail(
        'Oracle could not parse the connect string. Check the host, port, and service name for stray characters.',
      );
    }
    if (has('ORA-01031')) {
      return withDetail(
        `"${ctx.username}" does not have the privilege this connection needs. Downpick connects as an ordinary user — SYSDBA and SYSOPER connections are not supported.`,
      );
    }
    // Thin mode speaks TLS but NOT Oracle Native Network Encryption. A server with
    // SQLNET.ENCRYPTION_SERVER = REQUIRED cannot be reached at all, and the message it produces
    // gives no hint why, so naming the limitation is the whole answer here.
    // NJS-5xx is node-oracledb's own transport layer, reached only when none of the errno tests
    // above matched — so this is a "could not get a socket to the listener" of unknown cause.
    if (has('NJS-503', 'NJS-510', 'NJS-511')) {
      return withDetail(
        `Could not open a connection to ${target}. Check that the host and port are right, that the listener is running, and that no firewall or VPN is in the way.`,
      );
    }
    if (lower.includes('native network encryption')) {
      return withDetail(
        `${target} requires Oracle Native Network Encryption, which Downpick cannot use — it connects in Thin mode, which supports TLS but not the older native encryption. Ask a DBA to allow TLS, or to accept unencrypted connections from this client.`,
      );
    }
  }

  // Unrecognised — return the raw message rather than inventing an explanation for it.
  return `${ctx.operation ?? `Could not connect to ${engine} at ${target}`}: ${raw}`;
}
