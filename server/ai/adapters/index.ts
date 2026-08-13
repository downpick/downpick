import { AiProviderKind } from '../../vault/types';
import { ChatAdapter } from '../types';
import { createAnthropicAdapter } from './anthropic';
import { createGoogleAdapter } from './google';
import { createOpenAiAdapter } from './openai';

/**
 * Swappable so tests can drive the chat route end to end without a network call or a real
 * API key.
 */
type AdapterFactory = (kind: AiProviderKind) => ChatAdapter;
let factory: AdapterFactory | null = null;

export function setAdapterFactory(next: AdapterFactory | null): void {
  factory = next;
}

/**
 * Five provider kinds, three adapters: OpenAI, its compatible clones, and Azure all speak
 * the same chat-completions dialect and differ only in URL and auth header.
 */
export function adapterFor(kind: AiProviderKind): ChatAdapter {
  if (factory) return factory(kind);
  switch (kind) {
    case 'openai':
      return createOpenAiAdapter('openai');
    case 'openai_compatible':
      return createOpenAiAdapter('compatible');
    case 'azure_openai':
      return createOpenAiAdapter('azure');
    case 'anthropic':
      return createAnthropicAdapter();
    case 'google':
      return createGoogleAdapter();
  }
}
