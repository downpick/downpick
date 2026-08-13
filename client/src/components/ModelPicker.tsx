import React, { useState } from 'react';

/** Above this many models a flat checkbox list stops being scannable. */
const FILTER_THRESHOLD = 10;

export interface ModelPickerProps {
  /** Everything offerable: fetched from the provider, or the built-in list as a fallback. */
  available: string[];
  /** The subset the user has enabled. Ids here always render, even if not in `available`. */
  selected: string[];
  onToggle: (model: string) => void;
  /** Adds a hand-typed id and enables it. */
  onAdd: (model: string) => void;
  onFetch: () => void;
  fetching: boolean;
  fetchError: string | null;
  /** True once `available` came back from the provider rather than the built-in list. */
  fromApi: boolean;
}

/**
 * The model checkbox list, shared by the add form and each saved provider card so the two
 * cannot drift — the original version only offered this on the add form, which left a saved
 * provider stuck with whatever models it was created with.
 */
export function ModelPicker({
  available,
  selected,
  onToggle,
  onAdd,
  onFetch,
  fetching,
  fetchError,
  fromApi,
}: ModelPickerProps) {
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');

  // An enabled model the provider no longer lists still needs a checkbox, or it could never
  // be turned off.
  const all = [...new Set([...available, ...selected])];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? all.filter((m) => m.toLowerCase().includes(needle)) : all;

  function commitDraft() {
    const id = draft.trim();
    if (!id) return;
    onAdd(id);
    setDraft('');
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs text-text-muted uppercase tracking-wide">Models</span>
        <button
          className="text-xs text-accent hover:text-accent-hover disabled:opacity-50"
          onClick={onFetch}
          disabled={fetching}
        >
          {fetching ? 'Fetching…' : fromApi ? 'Refresh from API' : 'Fetch from API'}
        </button>
      </div>

      {all.length > FILTER_THRESHOLD && (
        <input
          className="input text-xs mb-1.5"
          value={filter}
          placeholder={`Filter ${all.length} models…`}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      )}

      <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1">
        {shown.map((model) => (
          <label
            key={model}
            className="flex items-center gap-2 cursor-pointer select-none text-sm text-text"
          >
            <input
              type="checkbox"
              className="accent-accent w-3.5 h-3.5 cursor-pointer flex-shrink-0"
              checked={selected.includes(model)}
              onChange={() => onToggle(model)}
            />
            <span className="font-mono text-xs break-all">{model}</span>
          </label>
        ))}
        {shown.length === 0 && (
          <p className="text-xs text-text-dim m-0">
            {all.length === 0
              ? 'No models yet — fetch them from the provider, or type an id below.'
              : 'Nothing matches that filter.'}
          </p>
        )}
      </div>

      <div className="flex gap-2 mt-2">
        <input
          className="input font-mono text-xs flex-1 min-w-0"
          value={draft}
          placeholder="Add a model id…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          spellCheck={false}
        />
        <button className="btn-ghost text-xs flex-shrink-0" onClick={commitDraft} disabled={!draft.trim()}>
          Add
        </button>
      </div>

      {fetchError ? (
        <p className="text-xs text-warning mt-1.5">
          ⚠ {fetchError} You can still type the model id yourself.
        </p>
      ) : (
        <p className="text-xs text-text-dim mt-1.5">
          {fromApi
            ? 'Listed by the provider for this key.'
            : 'Built-in list — fetch from the API to see what your key can actually use. Ids are passed straight through, so anything you type works too.'}
        </p>
      )}
    </div>
  );
}
