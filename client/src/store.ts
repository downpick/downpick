import { create } from 'zustand';
import { api, AiProviderInfo } from './api';
import {
  loadTabs,
  loadPersistFlag,
  savePersistFlag,
  saveTabs,
  clearTabs,
} from './persistence';

export type DbType = 'postgres' | 'sqlserver' | 'mongodb' | 'oracle';

export interface SavedConnection {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  /** Oracle only — part of the address, so unlike `database` it is saved with the connection. */
  serviceName?: string;
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

/** One statement's outcome, in execution order. Mirrors the server's StatementSummary. */
export interface StatementSummary {
  /** Driver-supplied verb ('UPDATE', 'CREATE', 'insertMany'). SQL Server exposes none. */
  command?: string;
  /** Rows the statement changed. Undefined for statements that report no count. */
  rowsAffected?: number;
  /** Rows returned, when the statement produced a result set. */
  rowCount?: number;
}

export interface QueryResult {
  columns: string[];
  columnTypes?: string[];
  // Positional: rows[i][n] is the value of columns[n]. Column names are not usable as
  // keys because a query can return two columns with the same name.
  rows: unknown[][];
  /** Rows returned in `rows` — never an affected-row count, which lives in `rowsAffected`. */
  rowCount: number;
  /** Rows changed across every statement in the batch. Undefined when none reported one. */
  rowsAffected?: number;
  /** One entry per statement the driver reported on. Drives the Messages view. */
  statements?: StatementSummary[];
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
  /** When the in-flight query started, for the live elapsed timer. Set with `isRunning`. */
  runStartedAt?: number;
  /** Id the server maps a cancel request back to, so any component can stop the query. */
  runQueryId?: string;
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
   * Results grid or the Messages list. Every new result picks the side that has something
   * to show — a statement with no result set (UPDATE, CREATE INDEX) would otherwise land
   * on an empty grid — and the status bar lets the user switch back.
   */
  resultView?: 'results' | 'messages';
  /**
   * Bumped every time the assistant pushes SQL in. Monaco is uncontrolled, so comparing
   * `sql` alone would silently skip an insert that matches what the store already holds —
   * which is exactly what happens when the user inserts a query, edits it, then hits
   * Insert on the same message again to start over.
   */
  sqlRevision?: number;
}

/**
 * The run fields, cleared. Spread by every terminal state (result, error) so a finished
 * query can never leave a timer ticking against a `runStartedAt` that no longer applies.
 */
const IDLE = { isRunning: false, runStartedAt: undefined, runQueryId: undefined } as const;

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
 * One tab's conversation.
 *
 * The transcript is mirrored into `~/.downpick/chats.db` as each exchange completes, so it
 * outlives New Chat, closing the tab, and quitting; `conversationId` is the link to that
 * row. That file is not in the vault and is not encrypted — the tradeoff, and how to clear
 * it, are stated in SECURITY.md.
 *
 * What lives here and never reaches disk is the runtime half: `draft`, `liveTrace`,
 * `thinking`, and `AiMessage.justInserted`. Same split `PersistedTab` makes in
 * persistence.ts, for the same reason — none of it means anything after a reload.
 */
export interface AiChat {
  messages: AiMessage[];
  draft: string;
  /** Trace lines that have arrived for the answer currently being generated. */
  liveTrace: AiTraceStep[];
  thinking: boolean;
  /** Row in chats.db this transcript is saved to. Null until the first exchange lands. */
  conversationId: string | null;
  /**
   * Where a resumed conversation started, when that is not where this tab points. Kept in
   * the store rather than component state so the notice survives the panel remounting.
   */
  origin: { connectionName: string; database: string } | null;
}

export function emptyAiChat(): AiChat {
  return {
    messages: [],
    draft: '',
    liveTrace: [],
    thinking: false,
    conversationId: null,
    origin: null,
  };
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
  /** Drops every connection at once. The vault lock closes the drivers server-side. */
  disconnectAllConnections: () => void;
  // Initializes (or updates) connection entry with the fetched databases list
  setDatabasesList: (id: string, databases: string[]) => void;
  setDatabasesLoading: (id: string, loading: boolean) => void;
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
  setTabResultView: (tabId: string, resultView: 'results' | 'messages') => void;
  setTabError: (tabId: string, error: string | null) => void;
  beginTabRun: (tabId: string, queryId: string) => void;

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
  /** Drops a saved conversation into a tab, replacing whatever it was showing. */
  loadAiChat: (
    tabId: string,
    conversationId: string,
    messages: AiMessage[],
    origin: { connectionName: string; database: string } | null,
  ) => void;
  /** Records the row id the first save minted. */
  setAiConversationId: (tabId: string, conversationId: string) => void;
  /** Unlinks a deleted conversation from every tab still holding it. */
  forgetAiConversation: (conversationId: string) => void;
  forgetAllAiConversations: () => void;
  /** The tab already showing this conversation, so resuming can go there instead of forking. */
  findTabForConversation: (conversationId: string) => string | null;

  /**
   * Configured AI providers, fetched once for the whole app. Every open tab has its own
   * mounted AI panel, so leaving this to the panel would mean one identical round trip per
   * tab every time the Settings dialog closes.
   */
  aiProviders: AiProviderInfo[];
  refreshAiProviders: () => Promise<void>;

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

export const useStore = create<AppState>((set, get) => ({
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

  // Locking the vault closes every driver in the main process. Without mirroring that here
  // the explorer would keep painting green dots at servers it can no longer reach, and the
  // first sign of trouble would be a query coming back "No active connection for this
  // database" — with nothing on screen explaining why, or that reconnecting is the fix.
  disconnectAllConnections: () =>
    set({ activeConnections: {}, connectingConnections: {}, connectErrors: {} }),

  setDatabasesList: (id, databases) =>
    set((s) => {
      const { [id]: _, ...connectErrors } = s.connectErrors;
      const existing = s.activeConnections[id];
      // On a refresh the list can come back without a database that used to be there.
      // Drop its cached schema rather than leaving a tree nothing can reach any more.
      // Open tabs are left alone on purpose: closing an editor out from under someone is
      // worse than a tab whose next query reports the database is gone.
      const schemas = existing
        ? Object.fromEntries(Object.entries(existing.schemas).filter(([db]) => databases.includes(db)))
        : {};
      return {
        connectErrors,
        activeConnections: {
          ...s.activeConnections,
          [id]: existing
            ? { ...existing, databases, databasesLoading: false, databasesError: null, schemas }
            : { id, databases, databasesLoading: false, databasesError: null, schemas },
        },
      };
    }),

  setDatabasesLoading: (id, loading) =>
    set((s) => {
      // Only a connected connection has a list to reload — never conjure an entry here,
      // since its presence is what marks a connection as connected.
      if (!s.activeConnections[id]) return s;
      return {
        activeConnections: {
          ...s.activeConnections,
          [id]: { ...s.activeConnections[id], databasesLoading: loading },
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
      // The conversation belongs to the tab — closing one drops the other. Since the
      // transcript is already in chats.db, what goes here is the cache, not the data.
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
          ? {
              ...t,
              result,
              error: null,
              ...IDLE,
              fromAi: false,
              viewMode: 'table',
              // A statement with no result set (UPDATE, CREATE INDEX) has nothing for the
              // grid, so it opens on its message instead of on an empty table.
              resultView: result.columns.length > 0 ? 'results' : 'messages',
            }
          : t
      ),
    })),
  setTabViewMode: (tabId, viewMode) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, viewMode } : t)),
    })),
  setTabResultView: (tabId, resultView) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, resultView } : t)),
    })),
  setTabError: (tabId, error) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, error, result: null, ...IDLE, fromAi: false } : t
      ),
    })),
  // Starting a run drops the previous result immediately. Leaving it on screen under a new
  // query's timer invites reading stale rows as if they were the new answer.
  beginTabRun: (tabId, queryId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              result: null,
              error: null,
              isRunning: true,
              runStartedAt: Date.now(),
              runQueryId: queryId,
            }
          : t
      ),
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

  // Starts from emptyAiChat() rather than the tab's current chat: a restored conversation
  // should not inherit a half-typed draft or a trace left over from what was there before.
  loadAiChat: (tabId, conversationId, messages, origin) =>
    set((s) => ({
      aiChats: { ...s.aiChats, [tabId]: { ...emptyAiChat(), messages, conversationId, origin } },
    })),

  setAiConversationId: (tabId, conversationId) =>
    set((s) => {
      const chat = s.aiChats[tabId];
      if (!chat) return s;
      return { aiChats: { ...s.aiChats, [tabId]: { ...chat, conversationId } } };
    }),

  // Without this, deleting a conversation from the history list would only remove the row:
  // the tab still holding its id would upsert it straight back into existence on the next
  // question, under the same id the user just deleted.
  forgetAiConversation: (conversationId) =>
    set((s) => {
      const entries = Object.entries(s.aiChats);
      if (!entries.some(([, chat]) => chat.conversationId === conversationId)) return s;
      return {
        aiChats: Object.fromEntries(
          entries.map(([id, chat]) =>
            chat.conversationId === conversationId ? [id, { ...chat, conversationId: null }] : [id, chat],
          ),
        ),
      };
    }),

  forgetAllAiConversations: () =>
    set((s) => ({
      aiChats: Object.fromEntries(
        Object.entries(s.aiChats).map(([id, chat]) => [id, { ...chat, conversationId: null }]),
      ),
    })),

  findTabForConversation: (conversationId) => {
    const { aiChats, tabs } = get();
    const match = Object.entries(aiChats).find(
      ([tabId, chat]) => chat.conversationId === conversationId && tabs.some((t) => t.id === tabId),
    );
    return match ? match[0] : null;
  },

  aiProviders: [],
  refreshAiProviders: async () => {
    try {
      const { providers } = await api.aiProviders();
      set({ aiProviders: providers });
    } catch {
      // Locked vault or a read failure. An empty list is what the panel already renders as
      // "no AI provider configured", which is the honest thing to show either way.
      set({ aiProviders: [] });
    }
  },

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
