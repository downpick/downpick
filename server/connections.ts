import { randomUUID } from 'crypto';
import * as vault from './vault/store';
import { ConnectionConfig, StoredConnection } from './vault/types';

// Re-exported so the rest of the server keeps importing its types from here.
export type {
  DbType,
  ConnectionConfig,
  ConnectionConfigWithPassword,
  StoredConnection,
} from './vault/types';

/**
 * Thin façade over the encrypted vault.
 *
 * Metadata and passwords live together inside vault.enc, each password inline on its
 * connection record, so deleting a connection cannot leave an orphaned secret behind.
 */

function stripPassword(connection: StoredConnection): ConnectionConfig {
  const { password: _password, ...metadata } = connection;
  return metadata;
}

/** Metadata only — this is what crosses the wire to the client. Never includes passwords. */
export function loadConnections(): ConnectionConfig[] {
  return vault.read().connections.map(stripPassword);
}

/** Full record including the password. Server-side only. */
export function findConnection(id: string): StoredConnection | undefined {
  return vault.read().connections.find((c) => c.id === id);
}

export function loadPassword(id: string): string {
  // A missing entry means no password was ever set — a legitimate state for e.g. a
  // no-auth local MongoDB. The driver surfaces its own auth failure from there.
  return findConnection(id)?.password ?? '';
}

export function createConnectionId(): string {
  return randomUUID();
}

export function addConnection(input: Omit<StoredConnection, 'id'>): Promise<string> {
  const id = createConnectionId();
  return vault.mutate((payload) => {
    payload.connections.push({ ...input, id });
    return id;
  });
}

/**
 * Replaces a connection's metadata. A `password` of undefined means "keep the stored one",
 * which is what the edit dialog sends when the user leaves the field blank.
 */
export function updateConnection(
  id: string,
  input: Omit<StoredConnection, 'id' | 'password'>,
  password?: string,
): Promise<boolean> {
  return vault.mutate((payload) => {
    const index = payload.connections.findIndex((c) => c.id === id);
    if (index === -1) return false;
    payload.connections[index] = {
      ...input,
      id,
      password: password || payload.connections[index].password,
    };
    return true;
  });
}

export function deleteConnection(id: string): Promise<boolean> {
  return vault.mutate((payload) => {
    const index = payload.connections.findIndex((c) => c.id === id);
    if (index === -1) return false;
    payload.connections.splice(index, 1);
    return true;
  });
}
