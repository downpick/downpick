import { Tab } from './store';

// localStorage keys (versioned so the shape can evolve without choking on old data).
const TABS_KEY = 'downpick.openTabs.v1';
const ACTIVE_KEY = 'downpick.activeTab.v1';
const FLAG_KEY = 'downpick.persistTabs.v1';
const PANELS_KEY = 'downpick.panelSizes.v1';

// Only the durable identity of a tab is persisted. Runtime fields (result, error,
// isRunning) are intentionally dropped — query results can be huge and a "running"
// state is meaningless after a reload.
interface PersistedTab {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
}

/** A range in the editor, in Monaco's 1-based line/column coordinates. */
export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Where a tab's editor stands right now: the whole buffer, plus whatever is selected. */
export interface EditorSnapshot {
  text: string;
  /** The selected text, or null when nothing is selected. */
  selectedText: string | null;
  /** Where that selection was, so an edit can be written back exactly where it came from. */
  selectionRange: EditorRange | null;
}

// Monaco editors are uncontrolled — the latest SQL only reaches the store on tab
// close. To capture in-progress edits when the user leaves the app, each mounted
// QueryEditor registers a getter here so saveTabs() can pull the live value.
//
// Ask AI reads the query through this same registry, which is why the getter hands back a
// snapshot rather than a bare string: the assistant needs the selection as well, and a
// second parallel registry for it would be one more thing to keep in sync.
const editorSnapshotGetters = new Map<string, () => EditorSnapshot>();

export function registerEditor(tabId: string, getSnapshot: () => EditorSnapshot): void {
  editorSnapshotGetters.set(tabId, getSnapshot);
}

export function unregisterEditor(tabId: string): void {
  editorSnapshotGetters.delete(tabId);
}

/** The live state of a tab's editor, or null when no editor is mounted for that tab. */
export function getEditorSnapshot(tabId: string): EditorSnapshot | null {
  return editorSnapshotGetters.get(tabId)?.() ?? null;
}

export function loadPersistFlag(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

export function savePersistFlag(enabled: boolean): void {
  try {
    localStorage.setItem(FLAG_KEY, enabled ? 'true' : 'false');
  } catch {
    /* storage unavailable (private mode / quota) — silently no-op */
  }
}

export function loadTabs(): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { tabs: [], activeTabId: null };

    const tabs: Tab[] = parsed
      .filter(
        (t): t is PersistedTab =>
          t && typeof t.id === 'string' && typeof t.connectionId === 'string',
      )
      .map((t) => ({
        id: t.id,
        connectionId: t.connectionId,
        connectionName: typeof t.connectionName === 'string' ? t.connectionName : '',
        database: typeof t.database === 'string' ? t.database : '',
        sql: typeof t.sql === 'string' ? t.sql : '',
        result: null,
        error: null,
        isRunning: false,
      }));

    const storedActive = localStorage.getItem(ACTIVE_KEY);
    const activeTabId = tabs.some((t) => t.id === storedActive)
      ? storedActive
      : tabs.length > 0
        ? tabs[tabs.length - 1].id
        : null;

    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

export function saveTabs(tabs: Tab[], activeTabId: string | null): void {
  try {
    const persisted: PersistedTab[] = tabs.map((t) => ({
      id: t.id,
      connectionId: t.connectionId,
      connectionName: t.connectionName,
      database: t.database,
      // Prefer the live editor value over the (possibly stale) store value.
      sql: editorSnapshotGetters.get(t.id)?.().text ?? t.sql,
    }));
    localStorage.setItem(TABS_KEY, JSON.stringify(persisted));
    if (activeTabId) localStorage.setItem(ACTIVE_KEY, activeTabId);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable — silently no-op */
  }
}

export function clearTabs(): void {
  try {
    localStorage.removeItem(TABS_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* no-op */
  }
}

// Sizes of the resizable layout panels. Persisted unconditionally (no opt-in
// setting) so the workspace layout survives reloads.
export interface PanelSizes {
  editorHeight: number;
  sidebarWidth: number;
  aiPanelWidth: number;
}

export function loadPanelSizes(): Partial<PanelSizes> {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return {};
    const out: Partial<PanelSizes> = {};
    if (typeof p.editorHeight === 'number') out.editorHeight = p.editorHeight;
    if (typeof p.sidebarWidth === 'number') out.sidebarWidth = p.sidebarWidth;
    if (typeof p.aiPanelWidth === 'number') out.aiPanelWidth = p.aiPanelWidth;
    return out;
  } catch {
    return {};
  }
}

export function savePanelSizes(sizes: PanelSizes): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(sizes));
  } catch {
    /* storage unavailable — silently no-op */
  }
}
