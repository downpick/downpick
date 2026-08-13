import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, ColumnNode, DbType, SavedConnection } from '../store';
import { api, copyToClipboard } from '../api';
import { ConnectionDialog } from './ConnectionDialog';
import { Icon, IconName } from './Icon';

/**
 * The sidebar: one tree from server to column.
 *
 * Connections and their contents used to be two stacked panels with a drag handle between
 * them, which meant the thing you clicked to connect and the thing that appeared when you
 * did were in different places — and the top panel's height was a permanent negotiation.
 * Here a connection *is* the root of its own subtree: connection → database → schema →
 * table → column.
 *
 * Rows are flattened into a single list rather than rendered as nested components. The
 * indent guides need to know their depth, filtering has to be able to drop a whole branch,
 * and a flat array makes both a matter of reading one row object.
 */

// NUL can't occur in an identifier the server hands back, so composite keys can't collide
// the way a '/' separator would for a database literally named "a/b".
const SEP = '\u0000';
const rowKey = (...parts: string[]) => parts.join(SEP);

/**
 * A connection row is the server, not the database — that distinction only became visible
 * when the two panels merged, and it is why Postgres and SQL Server take `server` here
 * while `database` belongs to the row below. Tabler carries no vendor mark for either of
 * them; MongoDB is the one type that keeps its own.
 */
const CONN_ICON: Record<DbType, IconName> = {
  postgres: 'server',
  sqlserver: 'server',
  mongodb: 'brand-mongodb',
};

// Postgres and SQL Server share a glyph, so the type moves into the tooltip rather than
// being lost with the vendor emoji it replaced.
const TYPE_LABEL: Record<DbType, string> = {
  postgres: 'PostgreSQL',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
};

// Handoff sizes: 13px inside the tree, 16px for the header controls.
const TREE_ICON = 13;
const HEADER_ICON = 16;

// The schema you almost certainly want when a database opens; the rest stay folded.
const DEFAULT_OPEN_SCHEMAS = new Set(['public', 'dbo', 'collections']);

const MENU_WIDTH = 170;
const INDENT = 12;

type RowKind = 'connection' | 'database' | 'schema' | 'table' | 'column';

interface Row {
  key: string;
  kind: RowKind;
  depth: number;
  label: string;
  icon: IconName;
  /** null for rows that have nothing to unfold. */
  chevron: 'down' | 'right' | null;
  /** Right-aligned detail: a table count, a column type. */
  meta?: string;
  title?: string;
  labelClass: string;
  iconClass?: string;
  dot?: 'connected' | 'disconnected' | 'error';
  busy?: boolean;
  /** Renders an indented error strip under the row, with a Retry that re-runs `onRetry`. */
  error?: string;
  onRetry?: () => void;
  selected?: boolean;
  conn: SavedConnection;
  database?: string;
  schema?: string;
  table?: string;
  column?: ColumnNode;
}

// `circle-filled` fills itself with currentColor, so the status colour is a text class.
const DOT_CLASS = {
  connected: 'text-success',
  disconnected: 'text-surface-3',
  error: 'text-error',
} as const;

const DOT_TITLE = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection failed',
} as const;

interface MenuItemSpec {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItemSpec[];
}

export const ExplorerTree = React.memo(function ExplorerTree() {
  const savedConnections = useStore((s) => s.savedConnections);
  const activeConnections = useStore((s) => s.activeConnections);
  const connectingConnections = useStore((s) => s.connectingConnections);
  const connectErrors = useStore((s) => s.connectErrors);
  const showConnectionDialog = useStore((s) => s.showConnectionDialog);
  // Derived to a string so the tree doesn't re-render every time a query result lands on
  // the active tab — only when the tab points at a different database.
  const selectedKey = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? rowKey(tab.connectionId, tab.database) : null;
  });

  const {
    setSavedConnections,
    disconnectConnection,
    setDatabasesList,
    setDatabasesError,
    setConnecting,
    setConnectError,
    setShowConnectionDialog,
    openDatabaseAndTab,
    setDatabaseSchema,
    setDatabaseSchemaLoading,
    setDatabaseSchemaError,
    openTab,
  } = useStore.getState();

  const [editingConn, setEditingConn] = useState<SavedConnection | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  function toggleSearch() {
    setShowSearch((open) => {
      const next = !open;
      if (!next) setSearch('');
      else requestAnimationFrame(() => searchInputRef.current?.focus());
      return next;
    });
  }

  function toggle(key: string, dflt: boolean) {
    setExpanded((e) => ({ ...e, [key]: !(e[key] ?? dflt) }));
  }

  function setOpen(key: string, open: boolean) {
    setExpanded((e) => ({ ...e, [key]: open }));
  }

  // ---- actions -------------------------------------------------------------

  async function handleConnect(conn: SavedConnection) {
    // Guard against a second click landing while the handshake is still in flight —
    // connecting can take seconds and the row stays clickable underneath the spinner.
    if (useStore.getState().connectingConnections[conn.id]) return;
    setConnecting(conn.id, true);
    setConnectError(conn.id, null);
    try {
      const { databases } = await api.connect(conn.id);
      setDatabasesList(conn.id, databases);
      setOpen(conn.id, true);
      void loadSchemasForOpenTabs(conn.id, databases);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Connection failed';
      // A failed connect must not leave a phantom entry in activeConnections — that would
      // render the connection as connected (green dot) and list its databases. Only report
      // through the subtree when the connection was already up.
      if (useStore.getState().activeConnections[conn.id]) setDatabasesError(conn.id, message);
      else setConnectError(conn.id, message);
    } finally {
      setConnecting(conn.id, false);
    }
  }

  // After (re)connecting, eagerly load schemas for databases that already have open tabs —
  // e.g. tabs restored from a previous session. Without this the tabs' SQL autocomplete has
  // no schema to draw from until the user clicks the database in the tree, which is
  // surprising. Loads run in parallel and failures are non-fatal (the schema can still be
  // refreshed by hand).
  async function loadSchemasForOpenTabs(connId: string, databases: string[]) {
    const pending = [
      ...new Set(
        useStore
          .getState()
          .tabs.filter((t) => t.connectionId === connId && databases.includes(t.database))
          .map((t) => t.database),
      ),
    ];
    await Promise.all(
      pending.map(async (database) => {
        setDatabaseSchemaLoading(connId, database, true);
        try {
          setDatabaseSchema(connId, database, await api.openDatabase(connId, database));
        } catch (e: unknown) {
          setDatabaseSchemaError(
            connId,
            database,
            e instanceof Error ? e.message : 'Failed to load schema',
          );
        }
      }),
    );
  }

  async function handleDisconnect(conn: SavedConnection) {
    try {
      await api.disconnect(conn.id);
    } catch {
      // The local session is going away either way.
    }
    disconnectConnection(conn.id);
  }

  async function handleDelete(conn: SavedConnection) {
    if (!confirm(`Delete "${conn.name}"?`)) return;
    await api.deleteConnection(conn.id);
    setSavedConnections(useStore.getState().savedConnections.filter((c) => c.id !== conn.id));
    setConnectError(conn.id, null);
    if (useStore.getState().activeConnections[conn.id]) disconnectConnection(conn.id);
  }

  /**
   * Loads the schema if it isn't in hand yet. Resolves once the tree can show columns.
   *
   * `openTabToo` always opens a *new* tab, never focuses an existing one: two tabs on the
   * same database is a normal way to work — a query on one side, a lookup on the other.
   * Folding a database back up is the chevron's job, so browsing does not go through here.
   */
  async function ensureSchema(conn: SavedConnection, database: string, openTabToo: boolean) {
    const dbSchema = useStore.getState().activeConnections[conn.id]?.schemas[database];
    if (dbSchema?.loading) return;
    setOpen(rowKey(conn.id, database), true);

    if (dbSchema?.schema) {
      if (openTabToo) openTab(conn.id, conn.name, database);
      return;
    }
    setDatabaseSchemaLoading(conn.id, database, true);
    try {
      const schema = await api.openDatabase(conn.id, database);
      // One set(): stores the schema and opens the tab in a single render cycle.
      if (openTabToo) openDatabaseAndTab(conn.id, conn.name, database, schema);
      else setDatabaseSchema(conn.id, database, schema);
    } catch (e: unknown) {
      setDatabaseSchemaError(
        conn.id,
        database,
        e instanceof Error ? e.message : 'Failed to open database',
      );
    }
  }

  /**
   * Unlike opening a database, a table's SELECT reuses the database's tab when there is
   * one — it rewrites the editor's contents, and doing that to a fresh tab every time
   * would strand the query the user was already working on.
   */
  function focusOrOpenTab(conn: SavedConnection, database: string, sql: string) {
    const { tabs, updateTabSql, setActiveTab } = useStore.getState();
    const existing = tabs.find((t) => t.connectionId === conn.id && t.database === database);
    if (!existing) {
      openTab(conn.id, conn.name, database, sql);
      return;
    }
    updateTabSql(existing.id, sql);
    setActiveTab(existing.id);
  }

  async function refreshSchema(conn: SavedConnection, database: string) {
    setDatabaseSchemaLoading(conn.id, database, true);
    try {
      setDatabaseSchema(conn.id, database, await api.schema(conn.id, database));
    } catch (e: unknown) {
      setDatabaseSchemaError(
        conn.id,
        database,
        e instanceof Error ? e.message : 'Failed to refresh',
      );
    }
  }

  function selectQuery(type: DbType, schema: string, table: string) {
    return type === 'mongodb'
      ? `db.${table}.find().limit(100)`
      : type === 'sqlserver'
        ? `SELECT TOP 100 *\nFROM [${schema}].[${table}];`
        : `SELECT *\nFROM "${schema}"."${table}"\nLIMIT 100;`;
  }

  function openTableQuery(row: Row) {
    const sql = selectQuery(row.conn.type, row.schema!, row.table!);
    focusOrOpenTab(row.conn, row.database!, sql);
  }

  function copy(text: string) {
    void copyToClipboard({ text }).catch(() => {
      // Nothing actionable to say for a failed clipboard write from a menu item.
    });
  }

  // ---- row interaction -----------------------------------------------------

  function handleRowClick(row: Row) {
    switch (row.kind) {
      case 'connection': {
        if (connectingConnections[row.conn.id]) return;
        if (!activeConnections[row.conn.id]) void handleConnect(row.conn);
        else toggle(row.conn.id, true);
        return;
      }
      // Clicking a database is how you start working in it: it opens (or focuses) that
      // database's query tab and unfolds it. Folding it back up is the chevron's job, so
      // returning to an open tab can't collapse the tree out from under you.
      case 'database':
        void ensureSchema(row.conn, row.database!, true);
        return;
      case 'schema':
      case 'table':
        toggle(row.key, row.kind === 'schema' && DEFAULT_OPEN_SCHEMAS.has(row.label));
        return;
      case 'column':
        return;
    }
  }

  function handleChevronClick(e: React.MouseEvent, row: Row) {
    if (row.kind === 'column') return;
    e.stopPropagation();
    if (row.kind === 'connection') {
      if (activeConnections[row.conn.id]) toggle(row.conn.id, true);
      else void handleConnect(row.conn);
      return;
    }
    // Browsing a database's tables without committing to a query tab.
    if (row.kind === 'database') {
      const loaded = !!activeConnections[row.conn.id]?.schemas[row.database!]?.schema;
      if (loaded) toggle(row.key, false);
      else void ensureSchema(row.conn, row.database!, false);
      return;
    }
    toggle(row.key, row.kind === 'schema' && DEFAULT_OPEN_SCHEMAS.has(row.label));
  }

  function menuItemsFor(row: Row): MenuItemSpec[] {
    switch (row.kind) {
      case 'connection': {
        const active = !!activeConnections[row.conn.id];
        return [
          active
            ? { label: 'Disconnect', onSelect: () => void handleDisconnect(row.conn) }
            : { label: 'Connect', onSelect: () => void handleConnect(row.conn) },
          { label: 'Edit…', onSelect: () => setEditingConn(row.conn) },
          { label: 'Delete', danger: true, onSelect: () => void handleDelete(row.conn) },
        ];
      }
      case 'database':
        return [
          {
            label: 'Open query tab',
            onSelect: () => void ensureSchema(row.conn, row.database!, true),
          },
          {
            label: 'Refresh schema',
            onSelect: () => void refreshSchema(row.conn, row.database!),
          },
          { label: 'Copy name', onSelect: () => copy(row.database!) },
        ];
      case 'schema':
        return [
          {
            label: 'Refresh schema',
            onSelect: () => void refreshSchema(row.conn, row.database!),
          },
          { label: 'Copy name', onSelect: () => copy(row.schema!) },
        ];
      case 'table':
        return [
          { label: 'Open SELECT query', onSelect: () => openTableQuery(row) },
          { label: 'Copy name', onSelect: () => copy(row.table!) },
        ];
      case 'column':
        return [
          { label: 'Copy column name', onSelect: () => copy(row.column!.name) },
          { label: 'Copy type', onSelect: () => copy(row.column!.type) },
        ];
    }
  }

  function openMenu(e: React.MouseEvent, row: Row) {
    e.preventDefault();
    e.stopPropagation();
    const items = menuItemsFor(row);
    setMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8)),
      // ~30px per item plus the menu's own padding, so a right-click near the bottom edge
      // still shows the whole menu.
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 30 - 16)),
      items,
    });
  }

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null);
    }
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    // The menu is positioned against the viewport, so anything that moves the row out from
    // under it has to dismiss it.
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  // ---- the tree ------------------------------------------------------------

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hit = (s: string) => !q || s.toLowerCase().includes(q);
    // A search flattens the folding open: a match five levels down is useless if the branch
    // above it is still folded.
    const isOpen = (key: string, dflt: boolean) => (q ? true : (expanded[key] ?? dflt));

    const out: Row[] = [];
    const sorted = [...savedConnections].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );

    for (const conn of sorted) {
      const active = activeConnections[conn.id];
      const connecting = !!connectingConnections[conn.id];
      const connMatch = hit(conn.name) || hit(conn.host);
      const connOpen = isOpen(conn.id, true);

      // Children are collected before the connection row is emitted, so a search that
      // matches nothing inside a connection can drop the whole branch.
      const children: Row[] = [];
      if (active && connOpen) {
        for (const database of active.databases ?? []) {
          const dbKey = rowKey(conn.id, database);
          const dbSchema = active.schemas[database];
          const dbOpen = isOpen(dbKey, false);
          const dbMatch = connMatch || hit(database);
          const dbChildren: Row[] = [];

          if (dbOpen && dbSchema?.schema) {
            // The server returns the opened database as the single entry in `databases`.
            for (const schemaNode of dbSchema.schema.databases[0]?.schemas ?? []) {
              const scKey = rowKey(conn.id, database, schemaNode.name);
              const scOpen = isOpen(scKey, DEFAULT_OPEN_SCHEMAS.has(schemaNode.name));
              const scMatch = dbMatch || hit(schemaNode.name);
              const tableRows: Row[] = [];

              if (scOpen) {
                for (const table of schemaNode.tables) {
                  if (q && !dbMatch && !hit(table.name)) continue;
                  const tKey = rowKey(conn.id, database, schemaNode.name, table.name);
                  const tOpen = isOpen(tKey, false);
                  tableRows.push({
                    key: tKey,
                    kind: 'table',
                    depth: 3,
                    label: table.name,
                    icon: 'table',
                    chevron: tOpen ? 'down' : 'right',
                    labelClass: 'text-text',
                    title: 'Double-click to query · right-click for actions',
                    conn,
                    database,
                    schema: schemaNode.name,
                    table: table.name,
                  });
                  if (!tOpen) continue;
                  for (const column of table.columns) {
                    tableRows.push({
                      key: rowKey(conn.id, database, schemaNode.name, table.name, column.name),
                      kind: 'column',
                      depth: 4,
                      label: column.name,
                      icon: 'column',
                      iconClass: 'text-text-dim',
                      chevron: null,
                      meta: column.type + (column.nullable ? ' ?' : ''),
                      title: `${column.name} — ${column.type}${column.nullable ? ' (nullable)' : ''}`,
                      labelClass: 'text-text',
                      conn,
                      database,
                      schema: schemaNode.name,
                      table: table.name,
                      column,
                    });
                  }
                }
              }

              if (q && tableRows.length === 0 && !scMatch) continue;
              dbChildren.push({
                key: scKey,
                kind: 'schema',
                depth: 2,
                label: schemaNode.name,
                icon: 'schema-folder',
                chevron: scOpen ? 'down' : 'right',
                meta: String(schemaNode.tables.length),
                labelClass: 'text-text-muted',
                conn,
                database,
                schema: schemaNode.name,
              });
              dbChildren.push(...tableRows);
            }
          }

          if (q && !dbMatch && dbChildren.length === 0) continue;
          const selected = selectedKey === dbKey;
          children.push({
            key: dbKey,
            kind: 'database',
            depth: 1,
            label: database,
            icon: 'database',
            chevron: dbOpen && dbSchema?.schema ? 'down' : 'right',
            labelClass: selected ? 'text-accent' : 'text-text',
            iconClass: selected ? 'text-accent' : undefined,
            title: `Click to open a query tab for ${database}`,
            busy: !!dbSchema?.loading,
            error: dbSchema?.error ?? undefined,
            onRetry: () => void refreshSchema(conn, database),
            selected,
            conn,
            database,
          });
          children.push(...dbChildren);
        }
      }

      if (q && !connMatch && children.length === 0) continue;

      const status = connecting
        ? undefined
        : active
          ? ('connected' as const)
          : connectErrors[conn.id]
            ? ('error' as const)
            : ('disconnected' as const);

      out.push({
        key: conn.id,
        kind: 'connection',
        depth: 0,
        label: conn.name,
        icon: CONN_ICON[conn.type],
        chevron: active && connOpen ? 'down' : 'right',
        labelClass: 'text-text font-semibold',
        // A live server is the one thing in the tree the handoff paints accent.
        iconClass: active ? 'text-accent' : undefined,
        title: `${conn.name} — ${TYPE_LABEL[conn.type]} · ${conn.host}:${conn.port}${
          active ? '' : ' (click to connect)'
        }`,
        dot: status,
        busy: connecting,
        error: connectErrors[conn.id]?.message ?? active?.databasesError ?? undefined,
        onRetry: () => void handleConnect(conn),
        conn,
      });
      out.push(...children);
    }
    return out;
    // The retry callbacks baked into the rows (handleConnect, refreshSchema) are recreated
    // every render but only ever read live store state, so they are not dependencies.
  }, [
    savedConnections,
    activeConnections,
    connectingConnections,
    connectErrors,
    expanded,
    search,
    selectedKey,
  ]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-2 bg-surface flex-shrink-0">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
          Explorer
        </span>
        <div className="flex items-center gap-2.5">
          {savedConnections.length > 0 && (
            <button
              className={`leading-none flex ${showSearch ? 'text-accent' : 'text-text-muted hover:text-text'}`}
              onClick={toggleSearch}
              title="Search"
              aria-label="Search"
            >
              <Icon name="search" size={HEADER_ICON} />
            </button>
          )}
          <button
            className="flex text-accent hover:text-accent-hover leading-none"
            onClick={() => setShowConnectionDialog(true)}
            title="Add connection"
            aria-label="Add connection"
          >
            <Icon name="plus" size={HEADER_ICON} />
          </button>
        </div>
      </div>

      {savedConnections.length > 0 && showSearch && (
        <div className="px-3 py-2 border-b border-surface-2 bg-surface flex-shrink-0">
          <input
            ref={searchInputRef}
            className="input text-xs py-1.5"
            placeholder="Search connections, databases, tables…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleSearch();
            }}
          />
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto min-h-0 py-1"
        onContextMenu={(e) => e.preventDefault()}
      >
        {rows.map((row) => (
          <TreeRow
            key={row.key}
            row={row}
            onClick={() => handleRowClick(row)}
            onDoubleClick={row.kind === 'table' ? () => openTableQuery(row) : undefined}
            onChevronClick={(e) => handleChevronClick(e, row)}
            onContextMenu={(e) => openMenu(e, row)}
          />
        ))}

        {rows.length === 0 && (
          <p className="text-text-dim text-xs px-3 py-4 text-center">
            {savedConnections.length === 0 ? (
              <>
                No connections yet.
                <br />
                Click + to add one.
              </>
            ) : (
              // Every saved connection is a row, so the only other way to empty the tree is
              // a search that matches nothing.
              <>No matches for “{search.trim()}”.</>
            )}
          </p>
        )}
      </div>

      {menu &&
        createPortal(
          <div
            role="menu"
            className="fixed z-50 bg-surface border border-surface-3 rounded shadow-xl py-1"
            style={{ top: menu.y, left: menu.x, width: MENU_WIDTH }}
            // Portals bubble events through the React tree, not the DOM tree — without these
            // a click on a menu item would also reach the row underneath it.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            {menu.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-2 ${
                  item.danger ? 'text-error' : 'text-text'
                }`}
                onClick={() => {
                  setMenu(null);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}

      {showConnectionDialog && (
        <ConnectionDialog onClose={() => setShowConnectionDialog(false)} />
      )}
      {editingConn && (
        <ConnectionDialog connection={editingConn} onClose={() => setEditingConn(null)} />
      )}
    </div>
  );
});

function TreeRow({
  row,
  onClick,
  onDoubleClick,
  onChevronClick,
  onContextMenu,
}: {
  row: Row;
  onClick: () => void;
  onDoubleClick?: () => void;
  onChevronClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <>
      <div
        className={`flex items-center gap-1.5 pr-2 cursor-pointer select-none tree-item ${
          row.selected ? 'selected' : ''
        }`}
        style={{
          paddingLeft: 8 + row.depth * INDENT,
          paddingTop: row.depth === 0 ? 6 : row.kind === 'column' ? 2 : 4,
          paddingBottom: row.depth === 0 ? 6 : row.kind === 'column' ? 2 : 4,
          // One hairline per ancestor level, so a deep row shows what it hangs off. Painted
          // as a background image (not borders) to keep every row a single flat element —
          // the hover colour shows through the gaps between the lines.
          ...(row.depth > 1 ? INDENT_GUIDE : null),
          ...(row.depth > 1 ? { backgroundSize: `${(row.depth - 1) * INDENT}px 100%` } : null),
        }}
        title={row.title ?? row.label}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <span
          className="flex items-center justify-center w-3.5 flex-shrink-0 text-text-muted"
          onClick={onChevronClick}
        >
          {row.chevron && (
            <Icon
              name={row.chevron === 'down' ? 'chevron-down' : 'chevron-right'}
              size={TREE_ICON}
            />
          )}
        </span>
        <Icon
          name={row.icon}
          size={TREE_ICON}
          className={`flex-shrink-0 ${row.iconClass ?? 'text-text-muted'}`}
        />
        <span className={`text-xs flex-1 min-w-0 truncate ${row.labelClass}`}>{row.label}</span>
        {row.meta && (
          <span className="text-xs text-text-dim flex-shrink-0 truncate max-w-[80px]">
            {row.meta}
          </span>
        )}
        {row.dot && (
          <span className={`flex flex-shrink-0 ${DOT_CLASS[row.dot]}`} title={DOT_TITLE[row.dot]}>
            <Icon name="circle-filled" size={10} />
          </span>
        )}
        {row.busy && (
          <Icon
            name="refresh"
            size={TREE_ICON}
            className="flex-shrink-0 animate-spin text-accent"
          />
        )}
      </div>

      {row.error && (
        <div
          className="mr-2 mb-1.5 mt-0.5 border-l-2 border-error pl-2 py-0.5"
          style={{ marginLeft: 8 + row.depth * INDENT + 24 }}
        >
          <p className="text-[11px] text-error truncate" title={row.error}>
            {row.error}
          </p>
          <button
            type="button"
            className="mt-0.5 text-[11px] text-error underline hover:text-error/80"
            onClick={(e) => {
              e.stopPropagation();
              row.onRetry?.();
            }}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );
}

const INDENT_GUIDE: React.CSSProperties = {
  backgroundImage: `repeating-linear-gradient(to right, #27272a 0 1px, transparent 1px ${INDENT}px)`,
  backgroundRepeat: 'no-repeat',
  // Lines up with the centre of the chevron column at depth 1.
  backgroundPosition: '14px 0',
};
