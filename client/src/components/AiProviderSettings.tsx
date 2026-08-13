import React, { useEffect, useState } from 'react';
import { api, AiProviderDefinition, AiProviderInfo, AiProviderKind } from '../api';
import { ModelPicker } from './ModelPicker';

/** Models listed by the provider, per saved provider id. Session-scoped, never persisted. */
type FetchedModels = Record<string, string[]>;

/**
 * Settings → AI providers.
 *
 * Unlike the rest of the Settings dialog, this section saves immediately rather than
 * through the dialog's Save button: adding a provider writes an API key into the vault,
 * and a half-entered key sitting in React state waiting for a Save click is a worse
 * arrangement than committing it the moment the user confirms.
 */
export function AiProviderSettings() {
  const [catalog, setCatalog] = useState<AiProviderDefinition[]>([]);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [view, setView] = useState<'list' | 'add'>('list');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Provider-listed models are fetched on demand rather than on open: this section is not
  // worth a round of third-party calls every time someone looks at their settings.
  const [fetched, setFetched] = useState<FetchedModels>({});
  const [fetchErrors, setFetchErrors] = useState<Record<string, string>>({});
  const [fetchingId, setFetchingId] = useState<string | null>(null);

  // Add-form state. Its picker lives under the reserved key 'new'.
  const [kind, setKind] = useState<AiProviderKind>('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);

  const definition = catalog.find((d) => d.kind === kind);

  async function refresh() {
    try {
      const data = await api.aiProviders();
      setCatalog(data.catalog);
      setProviders(data.providers);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load AI providers.');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Preselect the first built-in model so a provider added without touching the checkboxes
  // still has something in the chat model picker.
  useEffect(() => {
    setModels(definition?.models.slice(0, 1) ?? []);
    setFetched((current) => ({ ...current, new: [] }));
    setFetchErrors((current) => ({ ...current, new: '' }));
  }, [kind, definition?.models.length]);

  function resetForm() {
    setLabel('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setFetched((current) => ({ ...current, new: [] }));
    setFetchErrors((current) => ({ ...current, new: '' }));
    setError(null);
  }

  /** `key` is a saved provider's id, or 'new' for the add form. */
  async function fetchModels(key: string, body: Parameters<typeof api.discoverAiModels>[0]) {
    setFetchingId(key);
    setFetchErrors((current) => ({ ...current, [key]: '' }));
    try {
      const { models: listed } = await api.discoverAiModels(body);
      setFetched((current) => ({ ...current, [key]: listed }));
    } catch (e: unknown) {
      setFetchErrors((current) => ({
        ...current,
        [key]: e instanceof Error ? e.message : 'Could not list models.',
      }));
    } finally {
      setFetchingId(null);
    }
  }

  async function handleAdd() {
    if (!apiKey.trim()) {
      setError('An API key is required.');
      return;
    }
    if (models.length === 0) {
      setError('Pick at least one model, or type a model id.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.addAiProvider({
        provider: kind,
        label: label.trim() || definition?.label || kind,
        baseUrl: definition?.requiresBaseUrl ? baseUrl.trim() : undefined,
        apiKey: apiKey.trim(),
        models,
      });
      await refresh();
      resetForm();
      setView('list');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not add the provider.');
    } finally {
      setBusy(false);
    }
  }

  /** Optimistic: the checkbox flips at once and reverts if the write fails. */
  async function saveModels(provider: AiProviderInfo, next: string[]) {
    const previous = provider.models;
    setProviders((current) =>
      current.map((p) => (p.id === provider.id ? { ...p, models: next } : p)),
    );
    try {
      await api.updateAiProvider(provider.id, { models: next });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update the provider.');
      setProviders((current) =>
        current.map((p) => (p.id === provider.id ? { ...p, models: previous } : p)),
      );
    }
  }

  async function remove(provider: AiProviderInfo) {
    setBusy(true);
    try {
      await api.deleteAiProvider(provider.id);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not remove the provider.');
    } finally {
      setBusy(false);
    }
  }

  if (view === 'add') {
    const listed = fetched.new ?? [];
    return (
      <div className="flex flex-col gap-3.5 flex-1 min-h-0 overflow-y-auto pr-1">
        <button
          className="text-xs text-text-muted hover:text-text self-start"
          onClick={() => {
            resetForm();
            setView('list');
          }}
        >
          ← Providers
        </button>

        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">Provider</span>
          <select
            className="input mt-1.5"
            value={kind}
            onChange={(e) => setKind(e.target.value as AiProviderKind)}
          >
            {catalog.map((d) => (
              <option key={d.kind} value={d.kind}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">Display name</span>
          <input
            className="input mt-1.5"
            value={label}
            placeholder={definition?.label ?? ''}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        {definition?.requiresBaseUrl && (
          <div>
            <span className="text-xs text-text-muted uppercase tracking-wide">
              {definition.baseUrlLabel ?? 'Base URL'}
            </span>
            <input
              className="input font-mono text-xs mt-1.5"
              value={baseUrl}
              placeholder={definition.baseUrlPlaceholder ?? 'https://…'}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
            <p className="text-xs text-text-dim mt-1.5">
              A local address is fine — this is how you point Downpick at a model running on
              your own machine or network.
            </p>
          </div>
        )}

        <div>
          <span className="text-xs text-text-muted uppercase tracking-wide">API key</span>
          <input
            className="input font-mono text-xs mt-1.5"
            type="password"
            value={apiKey}
            placeholder="sk-…"
            onChange={(e) => setApiKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-text-dim mt-1.5">
            Stored in your encrypted vault alongside your database passwords, and never sent
            to the browser again.
          </p>
        </div>

        <ModelPicker
          available={listed.length > 0 ? listed : (definition?.models ?? [])}
          selected={models}
          fromApi={listed.length > 0}
          fetching={fetchingId === 'new'}
          fetchError={fetchErrors.new || null}
          onFetch={() =>
            void fetchModels('new', {
              provider: kind,
              apiKey: apiKey.trim(),
              baseUrl: definition?.requiresBaseUrl ? baseUrl.trim() : undefined,
            })
          }
          onToggle={(model) =>
            setModels((current) =>
              current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
            )
          }
          onAdd={(model) =>
            setModels((current) => (current.includes(model) ? current : [...current, model]))
          }
        />

        {error && <p className="text-sm text-error bg-error/10 rounded px-3 py-2">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            className="btn-ghost text-xs"
            onClick={() => {
              resetForm();
              setView('list');
            }}
          >
            Cancel
          </button>
          <button className="btn-primary text-xs" onClick={handleAdd} disabled={busy}>
            {busy ? 'Adding…' : '+ Add provider'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-start gap-3 flex-shrink-0">
        <p className="text-xs text-text-dim flex-1 m-0 leading-relaxed">
          Keys are kept in your encrypted vault. Asking a question sends your table, column,
          and schema <em>names</em> to the provider you pick — never any row data.
        </p>
        <button className="btn-primary text-xs flex-shrink-0" onClick={() => setView('add')}>
          + Add provider
        </button>
      </div>

      {error && <p className="text-sm text-error bg-error/10 rounded px-3 py-2">{error}</p>}

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
        {providers.length === 0 ? (
          <p className="text-xs text-text-dim m-0">No providers added yet.</p>
        ) : (
          providers.map((provider) => {
            const definitionFor = catalog.find((d) => d.kind === provider.provider);
            const listed = fetched[provider.id] ?? [];
            return (
              <div
                key={provider.id}
                className="border border-surface-3 rounded-xl p-3 flex flex-col gap-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text">{provider.label}</span>
                  <span className="text-[10px] text-text-dim border border-surface-3 rounded px-1.5 py-px">
                    {definitionFor?.label ?? provider.provider}
                  </span>
                  <div className="flex-1" />
                  <button
                    className="text-xs text-error hover:underline disabled:opacity-50"
                    onClick={() => void remove(provider)}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
                {provider.baseUrl && (
                  <p className="text-[11px] font-mono text-text-dim m-0 break-all">
                    {provider.baseUrl}
                  </p>
                )}

                <ModelPicker
                  available={listed.length > 0 ? listed : (definitionFor?.models ?? [])}
                  selected={provider.models}
                  fromApi={listed.length > 0}
                  fetching={fetchingId === provider.id}
                  fetchError={fetchErrors[provider.id] || null}
                  onFetch={() => void fetchModels(provider.id, { id: provider.id })}
                  onToggle={(model) =>
                    void saveModels(
                      provider,
                      provider.models.includes(model)
                        ? provider.models.filter((m) => m !== model)
                        : [...provider.models, model],
                    )
                  }
                  onAdd={(model) =>
                    provider.models.includes(model)
                      ? undefined
                      : void saveModels(provider, [...provider.models, model])
                  }
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
