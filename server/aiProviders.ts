import { randomUUID } from 'crypto';
import * as vault from './vault/store';
import { AiProviderKind, StoredAiProvider } from './vault/types';

export type { AiProviderKind, StoredAiProvider } from './vault/types';

/**
 * Thin façade over the encrypted vault for AI provider records, deliberately shaped like
 * connections.ts: the API key lives inline on the record (so removing a provider removes
 * its secret), and the only thing that ever crosses the wire is the stripped metadata.
 */

/** Provider metadata as the client sees it. Never carries the key. */
export interface AiProviderInfo {
  id: string;
  provider: AiProviderKind;
  label: string;
  baseUrl?: string;
  models: string[];
}

function stripApiKey(provider: StoredAiProvider): AiProviderInfo {
  const { apiKey: _apiKey, ...metadata } = provider;
  return metadata;
}

export function loadAiProviders(): AiProviderInfo[] {
  return vault.read().aiProviders.map(stripApiKey);
}

/** Full record including the key. Server-side only — never returned from a route. */
export function findAiProvider(id: string): StoredAiProvider | undefined {
  return vault.read().aiProviders.find((p) => p.id === id);
}

export function addAiProvider(input: Omit<StoredAiProvider, 'id'>): Promise<AiProviderInfo> {
  const id = randomUUID();
  return vault.mutate((payload) => {
    const record: StoredAiProvider = { ...input, id };
    payload.aiProviders.push(record);
    return stripApiKey(record);
  });
}

/**
 * Patches a provider in place. An absent `apiKey` means "keep the stored one", matching how
 * the connection edit dialog treats a blank password field.
 */
export function updateAiProvider(
  id: string,
  patch: Partial<Omit<StoredAiProvider, 'id' | 'provider'>>,
): Promise<AiProviderInfo | null> {
  return vault.mutate((payload) => {
    const index = payload.aiProviders.findIndex((p) => p.id === id);
    if (index === -1) return null;
    const current = payload.aiProviders[index];
    const next: StoredAiProvider = {
      ...current,
      label: patch.label ?? current.label,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      models: patch.models ?? current.models,
      apiKey: patch.apiKey || current.apiKey,
    };
    payload.aiProviders[index] = next;
    return stripApiKey(next);
  });
}

export function deleteAiProvider(id: string): Promise<boolean> {
  return vault.mutate((payload) => {
    const index = payload.aiProviders.findIndex((p) => p.id === id);
    if (index === -1) return false;
    payload.aiProviders.splice(index, 1);
    return true;
  });
}
