import { create } from 'zustand';
import {
  loadTabs,
  loadPersistFlag,
  savePersistFlag,
  saveTabs,
  clearTabs,
} from './persistence';

export type DbType = 'postgres' | 'sqlserver' | 'mongodb';

export interface SavedConnection {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  username: string;
}

export interface ColumnNode {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableNode {
  name: string;
  columns: ColumnNode[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
}

export interface DatabaseNode {
  name: string;
  schemas: SchemaNode[];
}

export interface SchemaTree {
  databases: DatabaseNode[];
}

export interface QueryResult {
  columns: string[];
  columnTypes?: string[];
  // Positional: rows[i][n] is the value of columns[n]. Column names are not usable as
  // keys because a query can return two columns with the same name.
  rows: unknown[][];
  rowCount: number;
  executionTime: number;
  truncated?: boolean;
  // Raw (non-flattened) documents, populated by document-oriented drivers (MongoDB) so the
  // client can offer an expandable per-document view alongside the flattened table view.
  documents?: Record<string, unknown>[];
}

export interface DbSchema {
  schema: SchemaTree | null;
  loading: boolean;
  error: string | null;
}

export interface Tab {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  result: QueryResult | null;
  error: string | null;
  isRunning: boolean;
  /** Set when the current SQL came from the assistant and has not been run since. */
  fromAi?: boolean;
  /**
   * Which shape the result is read in. Only document drivers (MongoDB) populate
   * `result.documents`, so only they ever offer the choice; every new result resets to the
   * table. Lives on the tab rather than inside ResultsGrid because the control that
   * switches it sits in the status bar, outside the grid.
   */
  viewMode?: 'table' | 'documents';
  /**
   * Bumped every time the assistant pushes SQL in. Monaco is uncontrolled, so comparing
   * `sql` alone would silently skip an insert that matches what the store already holds —
   * which is exactly what happens when the user inserts a query, edits it, then hits
   * Insert on the same message again to start over.
   */
  sqlRevision?: number;
}

export interface AiTraceStep {
  label: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Assistant only: the query offered for insertion. */
  sql?: string | null;
  /** Assistant only: the schema lookups it made on the way. */
  trace?: AiTraceStep[];
  /** Assistant only: true for a couple of seconds after the user inserts this query. */
  justInserted?: boolean;
  isError?: boolean;
}

/**
 * One tab's conversation. Deliberately in-memory only: persistence.ts already keeps raw SQL
 * in localStorage forever, and transcripts plus schema detail would widen that considerably
 * without the vault ever protecting any of it.
 */
export interface AiChat {
  messages: AiMessage[];
  draft: string;
  /** Trace lines that have arrived for the answer currently being generated. */
  liveTrace: AiTraceStep[];
  thinking: boolean;
}

export function emptyAiChat(): AiChat {
  return { messages: [], draft: '', liveTrace: [], thinking: false };
}

export interface ActiveConnection {
  id: string;
  databases: string[] | null;
  databasesLoading: boolean;
  databasesError: string | null;
  schemas: Record<string, DbSchema>;
}

export interface ConnectionError {
  message: string;
}

/** A pane in the Settings dialog's left rail. */
export type SettingsSection = 'general' | 'security' | 'ai';

interface AppState {
  savedConnections: SavedConnection[];
  setSavedConnections: (conns: SavedConnection[]) => void;

  activeConnections: Record<string, ActiveConnection>;
  // Ids of connections whose handshake is in flight. Kept apart from activeConnections so a
  // pending (or failed) connect never counts as connected.
  connectingConnections: Record<string, boolean>;
  setConnecting: (id: string, connecting: boolean) => void;
  // Last failed connect attempt, per connection — surfaced under its row in the explorer.
  connectErrors: Record<string, ConnectionError>;
  setConnectError: (id: string, error: string | null) => void;
  disconnectConnection: (id: string) => void;
  // Initializes (or updates) connection entry with the fetched databases list
  setDatabasesList: (id: string, databases: string[]) => void;
  setDatabasesError: (id: string, error: string) => void;
  // Combined action: store schema for a database AND open a new tab — one render cycle
  openDatabaseAndTab: (connId: string, connName: string, database: string, schema: SchemaTree) => void;
  setDatabaseSchema: (connId: string, database: string, schema: SchemaTree) => void;
  setDatabaseSchemaLoading: (connId: string, database: string, loading: boolean) => void;
  setDatabaseSchemaError: (connId: string, database: string, error: string | null) => void;

  tabs: Tab[];
  activeTabId: string | null;
  openTab: (connectionId: string, connectionName: string, database: string, sql?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabSql: (tabId: string, sql: string) => void;
  setTabResult: (tabId: string, result: QueryResult) => void;
  setTabViewMode: (tabId: string, viewMode: 'table' | 'documents') => void;
  setTabError: (tabId: string, error: string | null) => void;
  setTabRunning: (tabId: string, running: boolean) => void;

  showConnectionDialog: boolean;
  setShowConnectionDialog: (show: boolean) => void;
  showSettingsDialog: boolean;
  setShowSettingsDialog: (show: boolean) => void;
  /** Which Settings section to open on — the AI panel's empty state jumps straight to 'ai'. */
  settingsTab: SettingsSection;
  openSettings: (tab?: SettingsSection) => void;

  // Ask AI
  aiPanelOpen: boolean;
  setAiPanelOpen: (open: boolean) => void;
  /** Keyed by tab id — each editor tab holds its own conversation. */
  aiChats: Record<string, AiChat>;
  updateAiChat: (tabId: string, patch: (chat: AiChat) => Partial<AiChat>) => void;
  clearAiChat: (tabId: string) => void;
  /** Pushes generated SQL into a tab's editor and flags it as unrun AI output. */
  insertAiSql: (tabId: string, messageId: string, sql: string) => void;
  clearInsertedFlag: (tabId: string, messageId: string) => void;

  // When enabled, open tabs are saved to localStorage and restored on next launch.
  persistTabs: boolean;
  setPersistTabs: (enabled: boolean) => void;
}

let tabCounter = 0;
function newTabId() {
  return `tab-${++tabCounter}`;
}

// Restore persisted tabs at module load if the user enabled the feature.
const persistTabsEnabled = loadPersistFlag();
const restored = persistTabsEnabled ? loadTabs() : { tabs: [], activeTabId: null };

// Restored tab ids look like "tab-N". Seed the counter past the highest one so
// newly opened tabs can't collide with a restored id.
for (const t of restored.tabs) {
  const m = /^tab-(\d+)$/.exec(t.id);
  if (m) tabCounter = Math.max(tabCounter, Number(m[1]));
}

export const useStore = create<AppState>((set) => ({
  savedConnections: [],
  setSavedConnections: (conns) => set({ savedConnections: conns }),

  activeConnections: {},

  connectingConnections: {},
  setConnecting: (id, connecting) =>
    set((s) => {
      if (!connecting) {
        const { [id]: _, ...rest } = s.connectingConnections;
        return { connectingConnections: rest };
      }
      return { connectingConnections: { ...s.connectingConnections, [id]: true } };
    }),

  connectErrors: {},
  setConnectError: (id, error) =>
    set((s) => {
      if (error === null) {
        if (!(id in s.connectErrors)) return s;
        const { [id]: _, ...rest } = s.connectErrors;
        return { connectErrors: rest };
      }
      return {
        connectErrors: { ...s.connectErrors, [id]: { message: error } },
      };
    }),

  disconnectConnection: (id) =>
    set((s) => {
      const { [id]: _, ...activeConnections } = s.activeConnections;
      const { [id]: __, ...connectErrors } = s.connectErrors;
      return { activeConnections, connectErrors };
    }),

  setDatabasesList: (id, databases) =>
    set((s) => {
      const { [id]: _, ...connectErrors } = s.connectErrors;
      return {
        connectErrors,
        activeConnections: {
          ...s.activeConnections,
          [id]: s.activeConnections[id]
            ? { ...s.activeConnections[id], databases, databasesLoading: false, databasesError: null }
            : { id, databases, databasesLoading: false, databasesError: null, schemas: {} },
        },
      };
    }),

  setDatabasesError: (id, error) =>
    set((s) => ({
      activeConnections: {
        ...s.activeConnections,
        [id]: s.activeConnections[id]
          ? { ...s.activeConnections[id], databasesLoading: false, databasesError: error }
          : { id, databases: null, databasesLoading: false, databasesError: error, schemas: {} },
      },
    })),

  // Single set(): stores schema AND opens tab — schema tree re-render + Monaco mount in one cycle.
  openDatabaseAndTab: (connId, connName, database, schema) => {
    const id = newTabId();
    const tab: Tab = {
      id,
      connectionId: connId,
      connectionName: connName,
      database,
      sql: '',
      result: null,
      error: null,
      isRunning: false,
    };
    set((s) => ({
      activeConnections: {
        ...s.activeConnections,
        [connId]: {
          ...s.activeConnections[connId],
          schemas: {
            ...s.activeConnections[connId]?.schemas,
            [database]: { schema, loading: false, error: null },
          },
        },
      },
      tabs: [...s.tabs, tab],
      activeTabId: id,
    }));
  },

  setDatabaseSchema: (connId, database, schema) =>
    set((s) => ({
      activeConnections: {
        ...s.activeConnections,
        [connId]: {
          ...s.activeConnections[connId],
          schemas: {
            ...s.activeConnections[connId]?.schemas,
            [database]: { schema, loading: false, error: null },
          },
        },
      },
    })),

  setDatabaseSchemaLoading: (connId, database, loading) =>
    set((s) => ({
      activeConnections: {
        ...s.activeConnections,
        [connId]: {
          ...s.activeConnections[connId],
          schemas: {
            ...s.activeConnections[connId]?.schemas,
            [database]: {
              ...(s.activeConnections[connId]?.schemas[database] ?? { schema: null, error: null }),
              loading,
            },
          },
        },
      },
    })),

  setDatabaseSchemaError: (connId, database, error) =>
    set((s) => ({
      activeConnections: {
        ...s.activeConnections,
        [connId]: {
          ...s.activeConnections[connId],
          schemas: {
            ...s.activeConnections[connId]?.schemas,
            [database]: {
              ...(s.activeConnections[connId]?.schemas[database] ?? { schema: null, loading: false }),
              error,
              loading: false,
            },
          },
        },
      },
    })),

  tabs: restored.tabs,
  activeTabId: restored.activeTabId,
  openTab: (connectionId, connectionName, database, sql = '') => {
    const id = newTabId();
    const tab: Tab = {
      id,
      connectionId,
      connectionName,
      database,
      sql,
      result: null,
      error: null,
      isRunning: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
  },
  closeTab: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      let activeTabId = s.activeTabId;
      if (activeTabId === tabId) {
        activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      }
      // The conversation belongs to the tab — closing one drops the other.
      const { [tabId]: _closed, ...aiChats } = s.aiChats;
      return { tabs, activeTabId, aiChats };
    }),
  setActiveTab: (tabId) => set({ activeTabId: tabId }),
  updateTabSql: (tabId, sql) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === tabId)) return s;
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sql, fromAi: false } : t)) };
    }),
  // Running is what retires the "AI-generated · not run yet" badge, whether the run
  // succeeded or failed — either way the user has seen what the query does.
  setTabResult: (tabId, result) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        // viewMode resets here rather than in an effect: a new result is exactly when the
        // choice stops applying, and the old documents are gone the moment this lands.
        t.id === tabId
          ? { ...t, result, error: null, isRunning: false, fromAi: false, viewMode: 'table' }
          : t
      ),
    })),
  setTabViewMode: (tabId, viewMode) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, viewMode } : t)),
    })),
  setTabError: (tabId, error) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, error, result: null, isRunning: false, fromAi: false } : t
      ),
    })),
  setTabRunning: (tabId, running) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, isRunning: running } : t)),
    })),

  showConnectionDialog: false,
  setShowConnectionDialog: (show) => set({ showConnectionDialog: show }),
  showSettingsDialog: false,
  setShowSettingsDialog: (show) => set({ showSettingsDialog: show }),
  settingsTab: 'general',
  openSettings: (tab = 'general') => set({ showSettingsDialog: true, settingsTab: tab }),

  aiPanelOpen: false,
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),

  aiChats: {},
  updateAiChat: (tabId, patch) =>
    set((s) => {
      const current = s.aiChats[tabId] ?? emptyAiChat();
      return { aiChats: { ...s.aiChats, [tabId]: { ...current, ...patch(current) } } };
    }),
  clearAiChat: (tabId) =>
    set((s) => ({ aiChats: { ...s.aiChats, [tabId]: emptyAiChat() } })),

  // Reuses the same path SchemaTree's double-click takes: writing tab.sql is what makes
  // QueryEditor push the value into its (uncontrolled) Monaco instance.
  insertAiSql: (tabId, messageId, sql) =>
    set((s) => {
      const chat = s.aiChats[tabId];
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, sql, fromAi: true, sqlRevision: (t.sqlRevision ?? 0) + 1 }
            : t,
        ),
        aiChats: chat
          ? {
              ...s.aiChats,
              [tabId]: {
                ...chat,
                messages: chat.messages.map((m) => ({ ...m, justInserted: m.id === messageId })),
              },
            }
          : s.aiChats,
      };
    }),
  clearInsertedFlag: (tabId, messageId) =>
    set((s) => {
      const chat = s.aiChats[tabId];
      if (!chat) return s;
      return {
        aiChats: {
          ...s.aiChats,
          [tabId]: {
            ...chat,
            messages: chat.messages.map((m) =>
              m.id === messageId ? { ...m, justInserted: false } : m,
            ),
          },
        },
      };
    }),

  persistTabs: persistTabsEnabled,
  setPersistTabs: (enabled) =>
    set((s) => {
      savePersistFlag(enabled);
      if (enabled) saveTabs(s.tabs, s.activeTabId);
      else clearTabs();
      return { persistTabs: enabled };
    }),
}));

// Keep the persisted snapshot in sync as tabs are opened, closed, switched, or
// their SQL is committed to the store. saveTabs() also pulls live editor values,
// so this captures structural changes immediately and a flush on unload (see
// App.tsx) captures any in-progress edits.
useStore.subscribe((state, prev) => {
  if (!state.persistTabs) return;
  if (state.tabs !== prev.tabs || state.activeTabId !== prev.activeTabId) {
    saveTabs(state.tabs, state.activeTabId);
  }
});
