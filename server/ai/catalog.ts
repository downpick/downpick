import { AiProviderKind } from '../vault/types';

/**
 * What each provider kind needs and which models it offers out of the box.
 *
 * The model lists are a convenience, not a constraint: the add-provider form also takes a
 * free-text model id, so a model released after this file was written can be used without
 * waiting on a code change. Nothing here is validated against the provider — an unknown id
 * simply fails at the first request with the provider's own error.
 */
export interface ProviderDefinition {
  kind: AiProviderKind;
  label: string;
  /** True when the user must supply their own endpoint. */
  requiresBaseUrl: boolean;
  /** Label for the base URL field — Azure calls it something else. */
  baseUrlLabel?: string;
  /** Placeholder shown under the base URL field. */
  baseUrlPlaceholder?: string;
  models: string[];
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    requiresBaseUrl: false,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    requiresBaseUrl: false,
    models: [
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ],
  },
  {
    kind: 'google',
    label: 'Google Gemini',
    requiresBaseUrl: false,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    kind: 'openai_compatible',
    label: 'OpenAI compatible API',
    requiresBaseUrl: true,
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholder: 'http://localhost:11434/v1',
    models: [],
  },
  {
    kind: 'azure_openai',
    label: 'Azure OpenAI',
    requiresBaseUrl: true,
    baseUrlLabel: 'Azure endpoint',
    baseUrlPlaceholder: 'https://my-resource.openai.azure.com',
    models: [],
  },
];

export function findDefinition(kind: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((d) => d.kind === kind);
}

export function isProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === 'string' && PROVIDER_DEFINITIONS.some((d) => d.kind === value);
}
