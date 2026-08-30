import React, { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { api, setLockListener, VaultStatus } from './api';
import { saveTabs, loadPanelSizes, savePanelSizes } from './persistence';
import { VaultDialog } from './components/VaultDialog';
import { ExplorerTree } from './components/ExplorerTree';
import { QueryEditor } from './components/QueryEditor';
import { ResultsGrid } from './components/ResultsGrid';
import { SettingsDialog } from './components/SettingsDialog';
import { AiPanel } from './components/AiPanel';
import { StatusBar } from './components/StatusBar';
import { ToastHost } from './components/ToastHost';
import { Icon } from './components/Icon';
import Logo from './components/Logo';
import { IS_MAC } from './platform';

const MIN_EDITOR_HEIGHT = 100;
const MIN_SIDEBAR_WIDTH = 160;
// Narrower than this and the SQL blocks in the assistant's answers wrap into noise.
const MIN_AI_PANEL_WIDTH = 260;
const DEFAULT_AI_PANEL_WIDTH = 340;
// Floor for the editor column. Unlike the other panels, this one is dragged from its left
// edge and can eat the main area outright, so it yields first.
const MIN_MAIN_AREA_WIDTH = 420;

/**
 * Keeps the Ask AI panel from starving the editor column.
 *
 * Applied while dragging *and* on every render, because a width that fits today's window
 * may not fit after the window is narrowed — and a squeezed editor toolbar is what makes
 * the Run button collapse and overlap the panel. The ceiling wins over the floor when the
 * viewport cannot honour both.
 *
 * Note this clamps a *stored* width rather than replacing it: the user's chosen size is
 * kept as-is and simply rendered smaller while it does not fit, so widening the window
 * gives it back instead of having quietly destroyed it.
 */
function clampAiPanelWidth(want: number, sidebarWidth: number, viewportWidth: number): number {
  const ceiling = Math.max(
    MIN_AI_PANEL_WIDTH,
    viewportWidth - sidebarWidth - MIN_MAIN_AREA_WIDTH,
  );
  return Math.min(ceiling, Math.max(MIN_AI_PANEL_WIDTH, want));
}

export default function App() {
  // Narrow selectors — App only re-renders when these specific values change.
  // Previously used useStore() with no selector, which re-rendered App on every
  // Zustand mutation (setTabResult, setTabRunning, setSchemaLoading, etc.).
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  // Read here only to mark tabs whose connection is not live — see the tab bar below.
  const activeConnections = useStore((s) => s.activeConnections);

  const showSettingsDialog = useStore((s) => s.showSettingsDialog);
  const settingsTab = useStore((s) => s.settingsTab);
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);

  // Actions are stable references — read once, never subscribe.
  const {
    setActiveTab,
    closeTab,
    setShowConnectionDialog,
    setShowSettingsDialog,
    openSettings,
    setSavedConnections,
    refreshAiProviders,
    disconnectAllConnections,
  } = useStore.getState();

  // Restore persisted panel sizes once (lazy initializer runs a single read).
  const [savedPanels] = useState(loadPanelSizes);

  // Drag-to-resize: editor/results split
  const [editorHeight, setEditorHeight] = useState(savedPanels.editorHeight ?? 320);
  const editorDragRef = useRef(false);
  const editorStartY = useRef(0);
  const editorStartH = useRef(0);

  // Drag-to-resize: sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(savedPanels.sidebarWidth ?? 256);
  const sidebarDragRef = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartW = useRef(0);

  // Drag-to-resize: Ask AI panel. Its handle sits on the panel's left edge, so dragging
  // left has to *grow* it — the delta is subtracted rather than added.
  // The width the user asked for. What actually renders is this clamped to fit — see
  // effectiveAiPanelWidth below.
  const [aiPanelWidth, setAiPanelWidth] = useState(
    savedPanels.aiPanelWidth ?? DEFAULT_AI_PANEL_WIDTH,
  );
  // Tracked in state so a resize re-renders; the clamp is derived, never stored.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const effectiveAiPanelWidth = clampAiPanelWidth(aiPanelWidth, sidebarWidth, viewportWidth);
  const aiPanelDragRef = useRef(false);
  const aiPanelStartX = useRef(0);
  const aiPanelStartW = useRef(0);

  // Mirror the latest sizes so the mouseup handler (registered once) can persist
  // them without a stale closure — and without writing on every mousemove frame.
  // Updated synchronously inside onMove (not during render) so the value is current
  // at mouseup regardless of React's render timing.
  const sizesRef = useRef({ editorHeight, sidebarWidth, aiPanelWidth });

  function onEditorDragStart(e: React.MouseEvent) {
    editorDragRef.current = true;
    editorStartY.current = e.clientY;
    editorStartH.current = editorHeight;
    e.preventDefault();
  }

  function onSidebarDragStart(e: React.MouseEvent) {
    sidebarDragRef.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartW.current = sidebarWidth;
    e.preventDefault();
  }

  function onAiPanelDragStart(e: React.MouseEvent) {
    aiPanelDragRef.current = true;
    aiPanelStartX.current = e.clientX;
    aiPanelStartW.current = aiPanelWidth;
    e.preventDefault();
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (editorDragRef.current) {
        const delta = e.clientY - editorStartY.current;
        const next = Math.max(MIN_EDITOR_HEIGHT, editorStartH.current + delta);
        sizesRef.current.editorHeight = next;
        setEditorHeight(next);
      }
      if (sidebarDragRef.current) {
        const delta = e.clientX - sidebarStartX.current;
        const next = Math.max(MIN_SIDEBAR_WIDTH, sidebarStartW.current + delta);
        sizesRef.current.sidebarWidth = next;
        setSidebarWidth(next);
      }
      if (aiPanelDragRef.current) {
        const delta = e.clientX - aiPanelStartX.current;
        const next = clampAiPanelWidth(
          aiPanelStartW.current - delta,
          sizesRef.current.sidebarWidth,
          window.innerWidth,
        );
        sizesRef.current.aiPanelWidth = next;
        setAiPanelWidth(next);
      }
    }
    function onUp() {
      const wasDragging =
        editorDragRef.current || sidebarDragRef.current || aiPanelDragRef.current;
      editorDragRef.current = false;
      sidebarDragRef.current = false;
      aiPanelDragRef.current = false;
      // Persist once per drag, when the user releases the handle.
      if (wasDragging) savePanelSizes(sizesRef.current);
    }
    // Only records the new viewport; the panel width itself is clamped at render, so
    // narrowing the window shrinks the panel and widening it again gives the size back.
    function onResize() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // The vault gates everything: it starts locked on every server boot, so the app asks
  // for its state before trying to read anything out of it.
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  const refreshVault = React.useCallback(async () => {
    const status = await api.vaultStatus();
    setVaultStatus(status);
    if (!status.locked) {
      setSavedConnections(await api.listConnections());
    }
    return status;
  }, [setSavedConnections]);

  const lockVault = React.useCallback(async () => {
    await api.vaultLock().catch(() => {});
    void refreshVault();
  }, [refreshVault]);

  useEffect(() => {
    void refreshVault().catch(() => {});
    // Any call that comes back 423 — an idle auto-lock, a vault path change — puts the
    // unlock gate back up from wherever it happened.
    setLockListener(() => setVaultStatus((prev) => (prev ? { ...prev, locked: true } : prev)));
  }, [refreshVault]);

  // Configured providers, fetched here rather than in AiPanel — there is one panel per open
  // tab now, and they would otherwise each repeat this call.
  //
  // Both guards are load-bearing. `ai:providers:list` is behind the vault gate, and this
  // component mounts while the vault is still locked, so without the unlocked check the one
  // fetch of the session would 423 and every panel would sit on "no AI provider configured"
  // until something else happened to refetch. And refetching when the Settings dialog
  // closes is what stops the panel's own "Configure AI provider" button from sending the
  // user to Settings, adding a provider, and returning to the same empty state.
  const vaultUnlocked = Boolean(vaultStatus?.initialized && !vaultStatus.locked);

  // Locking closes every driver in the main process, so the tree's green dots and the
  // databases hanging under them stop describing anything real the moment it happens —
  // and the only symptom used to be the next query failing with "No active connection for
  // this database", long after the cause.
  //
  // Keyed off the vault status rather than done inside `lockVault`, because the paths that
  // never go through it need it just as much: the idle auto-lock and a vault-path switch,
  // which both arrive as a 423. And it clears on *both* edges of the gate — a request that
  // was still in flight when the lock landed reports its 423 afterwards, which would
  // otherwise pin "The vault is locked." under a connection row on the fresh unlock.
  const vaultGateUp = Boolean(vaultStatus && (!vaultStatus.initialized || vaultStatus.locked));
  useEffect(() => {
    disconnectAllConnections();
  }, [vaultGateUp, disconnectAllConnections]);

  useEffect(() => {
    if (showSettingsDialog || !vaultUnlocked) return;
    void refreshAiProviders();
  }, [showSettingsDialog, vaultUnlocked, refreshAiProviders]);

  // The menu items that act on the shell. The query commands are handled inside
  // QueryEditor, which is the only thing that knows which tab is active. Each one calls
  // the same function the on-screen control does — no second implementation to drift.
  //
  // The vault check is not redundant with the menu's own disabled state: this effect is
  // mounted above the lock gate below, so a command that arrives while the vault is shut
  // would otherwise flip `showSettingsDialog` on in a store nothing is rendering, and the
  // dialog would be sitting open the moment the user unlocked.
  useEffect(() => {
    return window.downpick.onMenuCommand((command) => {
      if (!vaultUnlocked) return;
      if (command === 'vault:lock') void lockVault();
      if (command === 'connection:new') setShowConnectionDialog(true);
      if (command === 'settings:open') openSettings('general');
      if (command === 'settings:ai') openSettings('ai');
    });
  }, [vaultUnlocked, lockVault, setShowConnectionDialog, openSettings]);

  // Clicking a native "query finished" notification brings the window forward (main does
  // that part) and lands here to open the tab the query came from. Same vault guard as the
  // menu effect above, and for the same reason: this sits above the lock gate.
  useEffect(() => {
    return window.downpick.onQueryNotificationClick(({ tabId }) => {
      if (!vaultUnlocked) return;
      // The tab may have been closed while the query was still running.
      if (useStore.getState().tabs.some((t) => t.id === tabId)) setActiveTab(tabId);
    });
  }, [vaultUnlocked, setActiveTab]);

  // Flush open tabs to localStorage when the user leaves, so in-progress (uncommitted)
  // editor edits are captured. The store subscription already saves structural changes;
  // this catches the latest SQL via the editor registry inside saveTabs().
  useEffect(() => {
    function flush() {
      const s = useStore.getState();
      if (s.persistTabs) saveTabs(s.tabs, s.activeTabId);
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') flush();
    }
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Gates. These sit after every hook, so the hook order never changes between renders.
  if (!vaultStatus) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-1 text-text-dim text-sm">
        <MacDragStrip />
        Starting…
      </div>
    );
  }
  if (!vaultStatus.initialized || vaultStatus.locked) {
    return (
      <div className="h-screen bg-surface-1">
        <MacDragStrip />
        <VaultDialog
          mode={vaultStatus.initialized ? 'unlock' : 'choose'}
          vaultPath={vaultStatus.path}
          onDone={() => void refreshVault()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-surface-1 text-text overflow-hidden">
      {showSettingsDialog && (
        <SettingsDialog
          initialTab={settingsTab}
          onClose={() => setShowSettingsDialog(false)}
          onChangeMasterPassword={() => {
            setShowSettingsDialog(false);
            setChangingPassword(true);
          }}
        />
      )}

      {changingPassword && (
        <VaultDialog
          mode="change"
          onDone={() => setChangingPassword(false)}
          onCancel={() => setChangingPassword(false)}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <div
          style={{ width: sidebarWidth }}
          className="flex flex-col flex-shrink-0 min-w-0"
        >
          {/* Room for the macOS traffic lights, which sit over the renderer now that the
              titlebar is hidden. Doubles as the window's drag handle. */}
          {IS_MAC && <div className="h-7 bg-surface flex-shrink-0 drag-region" />}

          {/* Connections and their databases, schemas, tables and columns — one tree. */}
          <ExplorerTree />
        </div>

        {/* Horizontal resize handle (sidebar ↔ main area) */}
        <div
          className="w-1.5 bg-surface-2 hover:bg-accent/40 cursor-col-resize flex-shrink-0 transition-colors"
          onMouseDown={onSidebarDragStart}
        />

        {/* Main area */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Tab bar */}
          <div className="flex items-end border-b border-surface-2 bg-surface overflow-x-auto flex-shrink-0">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer select-none flex-shrink-0 border-r border-surface-2 ${
                  tab.id === activeTabId
                    ? 'bg-surface-1 text-text tab-active'
                    : 'text-text-muted hover:bg-surface-2'
                }`}
                onClick={() => setActiveTab(tab.id)}
                // Middle click closes the tab. The mousedown guard suppresses the
                // browser's autoscroll, which the scrollable tab bar would otherwise start.
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  closeTab(tab.id);
                }}
              >
                <span
                  className="max-w-[140px] truncate"
                  title={`${tab.connectionName} / ${tab.database}`}
                >
                  {tab.database}
                </span>
                {/* A tab outlives its connection — the vault locking closes every driver,
                    and restored tabs come back before anything is connected at all. Saying
                    so here is what stops the next Run from being the first hint. */}
                {!activeConnections[tab.connectionId] && (
                  <span
                    className="flex flex-shrink-0 text-warning"
                    title={`Disconnected — open ${tab.database} from the explorer to reconnect`}
                  >
                    <Icon name="plug-connected-x" size={12} />
                  </span>
                )}
                {tab.isRunning && (
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                )}
                <button
                  className="ml-1 text-text-dim hover:text-error leading-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {tabs.length === 0 && (
              // Nothing to click here, so it drags too — otherwise the hint would punch a
              // dead spot into the middle of the strip's only draggable state.
              <div className={`px-4 py-2 text-xs text-text-dim ${IS_MAC ? 'drag-region' : ''}`}>
                No open tabs — open a database from the explorer
              </div>
            )}

            {/* The leftover strip to the right of the last tab drags the window, the way
                the empty part of Firefox's tab bar does. The tabs themselves stay out of
                the drag region, so clicking one still selects it — and `flex-basis: 0`
                collapses this away once the tabs overflow and scroll. */}
            {IS_MAC && <div className="flex-1 self-stretch drag-region" />}
          </div>

          {/* Editor + Results
              All tab panes are kept mounted simultaneously. Inactive tabs are hidden
              with display:none so their Monaco instances stay alive — switching tabs
              is a cheap CSS toggle instead of a full Monaco teardown + re-init. */}
          {tabs.length === 0 ? (
            <EmptyState onNewConnection={() => setShowConnectionDialog(true)} />
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className="flex flex-col flex-1 min-h-0"
                style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
              >
                {/* Editor pane */}
                <div style={{ height: editorHeight, flexShrink: 0 }} className="min-h-0">
                  <QueryEditor tab={tab} />
                </div>

                {/* Resize handle */}
                <div
                  className="h-1.5 bg-surface-2 hover:bg-accent/40 cursor-row-resize flex-shrink-0 transition-colors"
                  onMouseDown={onEditorDragStart}
                />

                {/* Results pane */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  <ResultsGrid
                    tabId={tab.id}
                    result={tab.result}
                    error={tab.error}
                    viewMode={tab.viewMode ?? 'table'}
                    resultView={tab.resultView ?? 'results'}
                    isRunning={tab.isRunning}
                    runStartedAt={tab.runStartedAt}
                  />
                </div>
              </div>
            ))
          )}
        </div>

        {/* Ask AI — one rail for the app, holding a panel per tab. It needs a tab to know
            which database to introspect, so it hides when none is open.

            The panels are all kept mounted and toggled with display:none, exactly like the
            editor and results panes above. That is what lets an answer keep streaming while
            the user works in another tab: unmounting aborts the request (see AiPanel's
            cleanup), so switching tabs used to throw away whatever was still generating. */}
        {aiPanelOpen && tabs.length > 0 && (
          <>
            {/* Horizontal resize handle (main area ↔ Ask AI) */}
            <div
              className="w-1.5 bg-surface-2 hover:bg-accent/40 cursor-col-resize flex-shrink-0 transition-colors"
              onMouseDown={onAiPanelDragStart}
            />
            {tabs.map((tab) => (
              <AiPanel
                key={tab.id}
                tab={tab}
                width={effectiveAiPanelWidth}
                hidden={tab.id !== activeTabId}
              />
            ))}
          </>
        )}
      </div>

      <StatusBar onLockVault={() => void lockVault()} />
      <ToastHost />
    </div>
  );
}

/**
 * Somewhere to grab the window before the shell exists.
 *
 * The gates render instead of the layout, so they have no sidebar strip to drag by — and
 * with the macOS titlebar hidden there is nothing else. Floats above the vault dialog's
 * own overlay, across a band where it has no controls.
 */
function MacDragStrip() {
  if (!IS_MAC) return null;
  return <div className="fixed top-0 left-0 right-0 h-7 z-[70] drag-region" />;
}

function EmptyState({ onNewConnection }: { onNewConnection: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-dim select-none">
      <Logo className="w-12 h-12 text-text-muted" />
      <div className="text-center">
        <p className="text-lg font-semibold text-text">Welcome to DOWNPICK</p>
        <p className="text-sm mt-1">Connect to a server, then click a database to start writing queries.</p>
      </div>
      <button className="btn-primary mt-2" onClick={onNewConnection}>
        + Add Connection
      </button>
    </div>
  );
}
