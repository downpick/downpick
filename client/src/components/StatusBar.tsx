import { useState } from 'react';
import { QueryResult, useStore } from '../store';
import { copyResult, exportCsv, exportXlsx } from '../resultExport';
import { formatDuration } from '../formatDuration';
import { ElapsedTime } from './ElapsedTime';

/**
 * The window's bottom chrome — the only in-app home for the vault and settings controls
 * since the titlebar header was removed.
 *
 * Reads the store directly rather than taking props for the tab state: it needs a
 * different slice than App does, and subscribing here keeps App from re-rendering the
 * whole layout every time a query finishes.
 */
/** Every labelled control in the bar wears the same ghost treatment. */
const BAR_BUTTON =
  'flex items-center gap-1.5 flex-shrink-0 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:bg-surface-2 hover:text-text transition-colors cursor-pointer whitespace-nowrap';

export function StatusBar({ onLockVault }: { onLockVault: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const { openSettings, setTabViewMode, setTabResultView } = useStore.getState();

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const result = activeTab && !activeTab.isRunning ? activeTab.result : null;
  const resultView = activeTab?.resultView ?? 'results';
  // Only a result set can be shown in the grid, copied or exported. A statement that
  // returned none (UPDATE, CREATE INDEX) has columns: [] and belongs to Messages alone.
  const hasResultSet = !!result && result.columns.length > 0;

  async function onCopy() {
    if (!result) return;
    setCopyStatus((await copyResult(result)) ? 'copied' : 'error');
    setTimeout(() => setCopyStatus('idle'), 1500);
  }

  return (
    <div className="flex items-center gap-3.5 h-[26px] flex-shrink-0 px-2.5 bg-surface border-t border-surface-2 select-none">
      {/* Only the unlocked presentation ships: locking swaps the whole window for the
          vault gate, so a locked status bar is never on screen. */}
      <button
        className={BAR_BUTTON}
        onClick={onLockVault}
        title="Vault unlocked — click to lock (⌘L)"
        aria-label="Lock vault"
      >
        <LockOpenIcon className="w-[13px] h-[13px] flex-shrink-0 text-success" />
        Vault unlocked
      </button>

      <span className="w-px h-3 bg-surface-2 flex-shrink-0" />

      {/* The only segment allowed to give ground when the window is narrow. */}
      {activeTab ? (
        <span className="text-[11px] text-text-muted truncate min-w-0">
          {activeTab.connectionName} · {activeTab.database}
        </span>
      ) : (
        <span className="text-[11px] text-text-dim truncate min-w-0">No connection</span>
      )}

      <div className="flex-1" />

      {activeTab?.isRunning && activeTab.runStartedAt != null && (
        <span className="flex items-center gap-1.5 text-[11px] text-text-muted flex-shrink-0">
          <SpinnerIcon className="w-[13px] h-[13px] flex-shrink-0 animate-spin text-accent" />
          Running…
          <span className="font-mono text-text">
            <ElapsedTime startedAt={activeTab.runStartedAt} />
          </span>
        </span>
      )}

      {result && (
        <>
          {result.truncated && (
            <span className="text-[11px] text-warning bg-warning/10 px-1.5 py-0.5 rounded flex-shrink-0">
              showing first 10,000 rows
            </span>
          )}

          <span className="text-[11px] font-mono text-text-dim flex-shrink-0">
            {summarize(result)}
          </span>

          <span className="w-px h-3 bg-surface-2 flex-shrink-0" />

          {/* Results and Messages are always both reachable: a batch can fill one, the other,
              or both, and only the user knows which half they came for. */}
          {activeTab && (
            <>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {(['results', 'messages'] as const).map((view) => (
                  <button
                    key={view}
                    className={`${BAR_BUTTON} ${
                      resultView === view
                        ? 'bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent'
                        : ''
                    }`}
                    onClick={() => setTabResultView(activeTab.id, view)}
                    aria-pressed={resultView === view}
                  >
                    {view === 'results' ? 'Results' : 'Messages'}
                    {/* Something happened that the grid can't show — say so rather than
                        making the user go looking for it. */}
                    {view === 'messages' &&
                      resultView === 'results' &&
                      result.rowsAffected != null && (
                        <span className="w-1 h-1 rounded-full bg-accent flex-shrink-0" />
                      )}
                  </button>
                ))}
              </div>

              <span className="w-px h-3 bg-surface-2 flex-shrink-0" />
            </>
          )}

          {/* Only document drivers (MongoDB) return documents, so only they get the choice. */}
          {resultView === 'results' && result.documents && activeTab && (
            <>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {(['table', 'documents'] as const).map((mode) => (
                  <button
                    key={mode}
                    className={`${BAR_BUTTON} ${
                      (activeTab.viewMode ?? 'table') === mode
                        ? 'bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent'
                        : ''
                    }`}
                    onClick={() => setTabViewMode(activeTab.id, mode)}
                    aria-pressed={(activeTab.viewMode ?? 'table') === mode}
                  >
                    {mode === 'table' ? 'Table' : 'Documents'}
                  </button>
                ))}
              </div>

              <span className="w-px h-3 bg-surface-2 flex-shrink-0" />
            </>
          )}

          {/* A result with no rows has nothing to carry anywhere — these would write an
              empty file. */}
          {hasResultSet && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                className={`${BAR_BUTTON} ${copyStatus === 'error' ? 'text-error' : ''}`}
                onClick={() => void onCopy()}
                title="Copy the result as a table"
              >
                <CopyIcon className="w-[13px] h-[13px] flex-shrink-0" />
                {copyStatus === 'copied'
                  ? 'Copied!'
                  : copyStatus === 'error'
                    ? 'Copy failed'
                    : 'Copy'}
              </button>
              <button
                className={BAR_BUTTON}
                onClick={() => exportCsv(result)}
                title="Export the result as CSV"
              >
                <DownloadIcon className="w-[13px] h-[13px] flex-shrink-0" />
                CSV
              </button>
              <button
                className={BAR_BUTTON}
                onClick={() => exportXlsx(result)}
                title="Export the result as an Excel workbook"
              >
                <DownloadIcon className="w-[13px] h-[13px] flex-shrink-0" />
                Excel
              </button>
            </div>
          )}
        </>
      )}

      <span className="w-px h-3 bg-surface-2 flex-shrink-0" />

      <button
        className="flex items-center justify-center w-[22px] h-5 rounded text-text-muted hover:bg-surface-2 hover:text-text transition-colors flex-shrink-0"
        onClick={() => openSettings('general')}
        title="Settings"
        aria-label="Settings"
      >
        <SettingsIcon className="w-3.5 h-3.5 flex-shrink-0" />
      </button>
    </div>
  );
}

/**
 * The one-line verdict on a finished run.
 *
 * "rows" and "rows affected" are different facts that used to print as the same one: an
 * UPDATE read "5 rows" above an empty grid on PostgreSQL, and "0 rows" on SQL Server.
 */
function summarize(result: QueryResult): string {
  const time = formatDuration(result.executionTime);
  if (result.columns.length > 0) return `${result.rowCount} rows · ${time}`;
  if (result.rowsAffected != null) {
    const rows = result.rowsAffected === 1 ? 'row' : 'rows';
    return `${result.rowsAffected} ${rows} affected · ${time}`;
  }
  return `Completed · ${time}`;
}

/**
 * Tabler outline glyphs, inlined.
 *
 * The design system specifies Tabler, but the prototype loads it from a CDN — which the
 * packaged app cannot reach. Two icons is far less weight than a font dependency, and
 * `currentColor` keeps them in step with the hover transition.
 */

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

function LockOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <circle cx="12" cy="16" r="1" />
      <path d="M8 11V7a4 4 0 0 1 8 0" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      <path d="M7 11l5 5 5-5" />
      <path d="M12 4v12" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
