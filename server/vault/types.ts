export type DbType = 'postgres' | 'sqlserver' | 'mongodb';

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  /** Never persisted — injected at runtime by open-db. */
  database?: string;
  username: string;
}

export interface ConnectionConfigWithPassword extends ConnectionConfig {
  password: string;
}

/**
 * A connection as it lives inside the vault.
 *
 * The password sits inline on the record rather than in a parallel `secrets` map keyed by
 * connection id. Two structures that have to be kept in sync eventually are not — an
 * earlier layout stored secrets separately and deleting a connection left its password
 * behind forever. Inline, deleting the record deletes the secret.
 */
export interface StoredConnection {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type AiProviderKind =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai_compatible'
  | 'azure_openai';

export interface StoredAiProvider {
  id: string;
  provider: AiProviderKind;
  label: string;
  /**
   * Required for 'openai_compatible' and 'azure_openai'. Only checked for scheme and shape
   * (see ai/net.ts) — private and loopback addresses are allowed on purpose, because a
   * local model server is the entire point of the openai_compatible kind.
   */
  baseUrl?: string;
  apiKey: string;
  /** Model ids the user enabled — exactly what the chat model picker offers. */
  models: string[];
}

export interface VaultPayload {
  /**
   * Bumped on every write. The store refuses to load a payload whose sequence has gone
   * backwards, which catches a `.bak` being swapped in under a running app.
   */
  writeSeq: number;
  connections: StoredConnection[];
  /** Reserved from v1 so adding AI providers needs no envelope version bump. */
  aiProviders: StoredAiProvider[];
}

export function emptyPayload(): VaultPayload {
  return { writeSeq: 0, connections: [], aiProviders: [] };
}

/** Decrypted payloads are authenticated, so this guards against version drift, not attack. */
export function normalizePayload(raw: unknown): VaultPayload {
  const p = (raw ?? {}) as Partial<VaultPayload>;
  return {
    writeSeq: Number.isFinite(p.writeSeq) ? Number(p.writeSeq) : 0,
    connections: Array.isArray(p.connections) ? p.connections : [],
    aiProviders: Array.isArray(p.aiProviders) ? p.aiProviders : [],
  };
}
