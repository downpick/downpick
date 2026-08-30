import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import MonacoEditor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { format } from 'sql-formatter';
import { useStore, Tab } from '../store';
import { api, ApiError } from '../api';
import { notifyQueryFinished } from '../notifyQueryFinished';
import { cancelTabQuery } from '../queryRun';
import { summarizeResult } from '../summarizeResult';
import { registerEditor, unregisterEditor, saveTabs } from '../persistence';
import { ConfirmDialog } from './ConfirmDialog';
import { splitSql, statementAtOffset, SqlDialect } from '../../../server/drivers/splitSql';
import { QUERY_TIMEOUT } from '../../../server/channels';

interface QueryEditorProps {
  tab: Tab;
}

/**
 * Which splitter grammar a connection's SQL follows. MongoDB has none — its shell syntax is not
 * SQL — so Run Statement is a no-op there rather than guessing at a dialect. The menu item stays
 * enabled because the menu is built once in the main process and knows nothing about which tab
 * is in front; a Mongo tab simply ignores F9.
 */
function dialectFor(connType: string | undefined): SqlDialect | null {
  if (connType === 'oracle') return 'oracle';
  if (connType === 'sqlserver') return 'sqlserver';
  if (connType === 'postgres') return 'postgres';
  return null;
}

// Completion provider is registered once globally, not per-editor-mount.
let completionRegistered = false;
let mongoCompletionRegistered = false;

// Top-level db.<collection>.<method>(...) calls, matching the operations the
// Mongo driver actually dispatches (see server/drivers/mongodb.ts). insertText uses
// Monaco snippet syntax ($1, $2, ...) so accepting a suggestion drops the cursor
// into the first argument; literal '$' in a snippet (e.g. the $set operator) must
// be escaped as '\$' or Monaco treats it as a placeholder marker.
const MONGO_METHODS: { name: string; snippet: string; detail: string }[] = [
  { name: 'find', snippet: 'find({$1})$0', detail: 'find(filter, projection?)' },
  { name: 'findOne', snippet: 'findOne({$1})$0', detail: 'findOne(filter, projection?)' },
  { name: 'aggregate', snippet: 'aggregate([$1])$0', detail: 'aggregate(pipeline)' },
  { name: 'countDocuments', snippet: 'countDocuments({$1})$0', detail: 'countDocuments(filter?)' },
  { name: 'estimatedDocumentCount', snippet: 'estimatedDocumentCount()$0', detail: 'estimatedDocumentCount()' },
  { name: 'distinct', snippet: "distinct('$1')$0", detail: 'distinct(field, filter?)' },
  { name: 'insertOne', snippet: 'insertOne({$1})$0', detail: 'insertOne(doc)' },
  { name: 'insertMany', snippet: 'insertMany([$1])$0', detail: 'insertMany(docs)' },
  { name: 'updateOne', snippet: 'updateOne({$1}, {\\$set:{$2}})$0', detail: 'updateOne(filter, update)' },
  { name: 'updateMany', snippet: 'updateMany({$1}, {\\$set:{$2}})$0', detail: 'updateMany(filter, update)' },
  { name: 'replaceOne', snippet: 'replaceOne({$1}, {$2})$0', detail: 'replaceOne(filter, replacement)' },
  { name: 'deleteOne', snippet: 'deleteOne({$1})$0', detail: 'deleteOne(filter)' },
  { name: 'deleteMany', snippet: 'deleteMany({$1})$0', detail: 'deleteMany(filter)' },
];

// Chained cursor modifiers — only valid after find(), but offered after any call
// chain for simplicity; the server rejects them elsewhere with a clear error.
const MONGO_CHAIN_METHODS: { name: string; snippet: string; detail: string }[] = [
  { name: 'sort', snippet: 'sort({$1: 1})$0', detail: 'sort(spec)' },
  { name: 'limit', snippet: 'limit($1)$0', detail: 'limit(n)' },
  { name: 'skip', snippet: 'skip($1)$0', detail: 'skip(n)' },
  { name: 'project', snippet: 'project({$1: 1})$0', detail: 'project(spec)' },
];

// Maps Monaco model URI → { connectionId, database } so the single global completion
// provider can look up the right schema for whichever editor is asking for completions.
// Populated in handleEditorMount, cleaned up on tab unmount.
const modelConnectionMap = new Map<string, { connectionId: string; database: string }>();

// Returns true if `stmt` has a WHERE keyword at the top level (depth 0), i.e. not
// nested inside parentheses. A WHERE that only appears inside a subquery still leaves
// the outer UPDATE/DELETE affecting every row, so it must not count as "safe".
function hasTopLevelWhere(stmt: string): boolean {
  let depth = 0;
  const re = /\(|\)|\bwhere\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt)) !== null) {
    const tok = m[0];
    if (tok === '(') depth++;
    else if (tok === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) return true;
  }
  return false;
}

// Scans forward from just inside a call's opening '(' and returns the text of its
// first argument — up to the first top-level ',' or the call's closing ')' —
// respecting nested parens/brackets/braces and quoted strings along the way.
function findFirstArgText(text: string, argsStart: number): string {
  let depth = 0;
  let inString: string | null = null;
  let i = argsStart;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) break;
  }
  return text.slice(argsStart, i);
}

// Detects .updateMany(/.deleteMany( calls whose filter argument is empty ({} or
// blank) — the Mongo-shell equivalent of an UPDATE/DELETE with no WHERE clause,
// since an empty filter matches every document in the collection.
function unsafeMongoWrites(text: string): string[] {
  const flagged: string[] = [];
  const re = /\.(updateMany|deleteMany)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const firstArg = findFirstArgText(text, m.index + m[0].length).replace(/\s+/g, '');
    if (firstArg === '' || firstArg === '{}') {
      flagged.push(m[1]);
    }
  }
  return flagged;
}

// Detects UPDATE / DELETE statements that have no top-level WHERE clause (would
// affect every row). Returns the list of offending verbs (e.g. ['UPDATE', 'DELETE']).
// Comments and string/identifier literals are stripped first so keywords inside
// them aren't mistaken for SQL structure.
function unsafeStatements(sql: string): string[] {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/--[^\n]*/g, ' ')            // line comments
    .replace(/'(?:''|[^'])*'/g, "''")     // single-quoted strings
    .replace(/"(?:""|[^"])*"/g, '""');    // quoted identifiers

  const flagged: string[] = [];
  for (const raw of cleaned.split(';')) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const m = /^(update|delete)\b/i.exec(stmt);
    if (m && !hasTopLevelWhere(stmt)) {
      flagged.push(m[1].toUpperCase());
    }
  }
  return flagged;
}

// Custom memo comparison: re-render only when fields QueryEditor actually uses change.
// Excludes tab.result and tab.error — those are rendered by ResultsGrid, not here. This
// prevents the Monaco editor from reacting to every setTabResult call, which was causing a
// synchronous render cascade.
function tabPropsEqual(prev: QueryEditorProps, next: QueryEditorProps) {
  return (
    prev.tab.id === next.tab.id &&
    prev.tab.connectionId === next.tab.connectionId &&
    prev.tab.connectionName === next.tab.connectionName &&
    prev.tab.database === next.tab.database &&
    prev.tab.sql === next.tab.sql &&
    // isRunning is the exception among the runtime fields: it swaps the toolbar's Run
    // button for Stop, so this component does have to see it. Twice per query, and Monaco
    // itself is uncontrolled — the re-render never reaches the editor's model.
    prev.tab.isRunning === next.tab.isRunning &&
    // Both drive the toolbar: fromAi shows the badge, sqlRevision forces a re-push of
    // assistant SQL that happens to match what the store already holds.
    prev.tab.fromAi === next.tab.fromAi &&
    prev.tab.sqlRevision === next.tab.sqlRevision
  );
}

function SparkleIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0.5l1.6 4.4L14 6.5l-4.4 1.6L8 12.5l-1.6-4.4L2 6.5l4.4-1.6L8 0.5z" />
      <path d="M13 10l.7 1.8L15.5 12.5l-1.8.7L13 15l-.7-1.8L10.5 12.5l1.8-.7L13 10z" opacity="0.7" />
    </svg>
  );
}

export const QueryEditor = React.memo(function QueryEditor({ tab }: QueryEditorProps) {
  // Only re-render from Zustand when connection status changes — not on tab result/running updates.
  const isConnected = useStore((s) => !!s.activeConnections[tab.connectionId]);
  const connType = useStore((s) => s.savedConnections.find((c) => c.id === tab.connectionId)?.type);
  // Which tab is active — used only to trigger a layout() call when this tab
  // becomes visible after being hidden with display:none.
  const activeTabId = useStore((s) => s.activeTabId);
  // The Ask AI panel is a single app-level rail, so its toggle lives in the store.
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);
  const setAiPanelOpen = useStore.getState().setAiPanelOpen;

  // Running state lives on the tab, not here: the results pane and the status bar both
  // show the run, and the tab bar marks a query still going in a background tab. It costs
  // one extra store write per query (at the start; the finish already went through
  // setTabResult) — the ticking timer stays out of the store entirely, see ElapsedTime.
  const isRunning = tab.isRunning;
  // Drives the button label ("Run" vs "Run Selection") — updates only when selection
  // transitions between empty ↔ non-empty, so renders are infrequent.
  const [hasSelection, setHasSelection] = useState(false);

  // Confirmation dialog state. `confirm` holds the message to show; the pending
  // resolver lets runQuery `await` the user's choice as if it were window.confirm.
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const askConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmMessage(message);
    });
  }, []);

  const resolveConfirm = useCallback((ok: boolean) => {
    setConfirmMessage(null);
    confirmResolveRef.current?.(ok);
    confirmResolveRef.current = null;
  }, []);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  // Ref mirror of the current selection — read inside runQuery without making it
  // a useCallback dependency (which would force re-registering the keyboard command).
  const selectionRef = useRef<Monaco.Selection | null>(null);
  const tabIdRef = useRef(tab.id);
  // Tracks the last SQL we pushed into the editor from outside (on mount or from SchemaTree).
  const lastExternalSqlRef = useRef(tab.sql);
  // Populated after runQuery/formatQuery are defined below; kept as refs so
  // handleEditorMount's onKeyDown closure always calls the latest version.
  const runQueryRef = useRef<() => void>(() => {});
  const runStatementRef = useRef<() => void>(() => {});
  const formatQueryRef = useRef<() => void>(() => {});
  const stopQueryRef = useRef<() => void>(() => {});

  // Persist SQL to Zustand on unmount (only fires when a tab is *closed*, not on
  // tab switch — editors are now kept mounted with display:none between switches).
  // Also cleans up the modelConnectionMap entry so the completion provider doesn't
  // hold a stale reference to a closed connection.
  // Still deferred so the set() doesn't fire synchronously during React cleanup.
  useEffect(() => {
    return () => {
      const tabId = tabIdRef.current;
      const editor = editorRef.current;
      // If Monaco never finished mounting, there's nothing to persist. This guard
      // matters for React StrictMode's throwaway first mount in dev: the cleanup
      // fires before onMount, so editorRef is null. Without it we'd write an empty
      // string to the store and clobber SQL restored from a previous session
      // before the real editor mounts and reads it via defaultValue.
      if (!editor) return;
      const model = editor.getModel();
      if (model) modelConnectionMap.delete(model.uri.toString());
      unregisterEditor(tabId);
      const sql = editor.getValue();
      setTimeout(() => {
        useStore.getState().updateTabSql(tabId, sql);
      }, 0);
    };
  }, []);

  // Apply external SQL changes (e.g. SchemaTree double-click) to the uncontrolled editor.
  useEffect(() => {
    if (editorRef.current && tab.sql !== lastExternalSqlRef.current) {
      lastExternalSqlRef.current = tab.sql;
      editorRef.current.setValue(tab.sql);
    }
  }, [tab.sql]);

  // The assistant's "Insert into editor" bumps sqlRevision. Keyed on the counter rather
  // than the text so re-inserting the same query after the user has edited it still lands
  // — the effect above compares values and would consider that a no-op.
  const lastRevisionRef = useRef(tab.sqlRevision ?? 0);
  useEffect(() => {
    const revision = tab.sqlRevision ?? 0;
    if (revision === lastRevisionRef.current) return;
    lastRevisionRef.current = revision;
    lastExternalSqlRef.current = tab.sql;
    editorRef.current?.setValue(tab.sql);
    editorRef.current?.focus();
  }, [tab.sqlRevision, tab.sql]);

  // When this tab becomes the active one it transitions from display:none → display:flex.
  // 1. layout() — automaticLayout uses a ResizeObserver that can lag one frame; calling
  //    it immediately ensures the editor fills its container without a visible flicker.
  // 2. focus() — Monaco's addCommand only fires on the focused editor instance. Without
  //    this, Ctrl+Enter would keep firing on whichever editor last had focus (typically
  //    the most recently opened tab), even after switching to a different tab.
  useEffect(() => {
    if (activeTabId === tab.id) {
      editorRef.current?.layout();
      editorRef.current?.focus();
    }
  }, [activeTabId, tab.id]);

  // F5 runs the query, matching the muscle memory of classic SQL clients (SSMS,
  // DBeaver, etc.). Registered at the window level (capture phase) so it fires no
  // matter where focus is, and preventDefault() stops the browser's page reload.
  // Every mounted tab editor registers this, but only the active tab acts — the
  // others bail on the activeTabId guard, so there's exactly one preventDefault/run.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'F5' || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (useStore.getState().activeTabId !== tabIdRef.current) return;
      e.preventDefault();
      runQueryRef.current();
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  // The application menu drives the same actions as the toolbar buttons. Every mounted tab
  // editor subscribes, and the activeTabId guard — the same one F5 uses above — keeps
  // exactly one of them from acting.
  useEffect(() => {
    return window.downpick.onMenuCommand((command) => {
      if (useStore.getState().activeTabId !== tabIdRef.current) return;
      if (command === 'query:run') runQueryRef.current();
      else if (command === 'query:runStatement') runStatementRef.current();
      else if (command === 'query:cancel') stopQueryRef.current();
      else if (command === 'query:format') formatQueryRef.current();
    });
  }, []);

  /**
   * The shared run path.
   *
   * `lineOffset` is how many lines above `sql` sat in the document. The driver reports an error
   * line relative to what it was SENT, so running a selection or a single statement used to
   * report "Line 1" for an error forty lines down the file. Adding the offset back here is what
   * makes the marker point at the line the user is actually looking at.
   */
  const runSql = useCallback(
    async (sql: string, lineOffset: number) => {
      if (!sql.trim()) return;

      // Guard against accidentally rewriting/deleting every row/document in the target.
      const unsafe = connType === 'mongodb' ? unsafeMongoWrites(sql) : unsafeStatements(sql);
      if (unsafe.length > 0) {
        const verbs = [...new Set(unsafe)].join(' / ');
        const noun = connType === 'mongodb' ? 'call' : 'statement';
        const label =
          unsafe.length === 1
            ? `a ${unsafe[0]} ${noun}`
            : `${unsafe.length} ${verbs} ${noun}s`;
        const message = connType === 'mongodb'
          ? `You're about to run ${label} with an empty filter ({}).\n\n` +
            `This will affect ALL documents in the collection and cannot be undone.`
          : `You're about to run ${label} without a WHERE clause.\n\n` +
            `This will affect ALL rows in the table and cannot be undone.`;
        const ok = await askConfirm(message);
        if (!ok) return;
      }

      // Unique id so the server can map a Stop request back to this exact query. It goes on
      // the tab so the Cancel button in the results pane can reach it too.
      const queryId = crypto.randomUUID();

      // Wall-clock, not `result.executionTime`: what decides whether this run is worth
      // announcing is how long the user waited, which includes the round trip and — for a
      // timeout — a run that never produced an executionTime at all.
      const startedAt = Date.now();
      // Only the fields the notice needs, so the callback does not have to depend on the whole
      // `tab` prop — that object is replaced on every store update, and this closure is held
      // in a ref that the toolbar, F5, and the menu all fire through.
      const origin = { id: tab.id, connectionName: tab.connectionName, database: tab.database };

      // Clears the previous result and starts the timer.
      useStore.getState().beginTabRun(tab.id, queryId);

      try {
        const result = await api.query(tab.connectionId, tab.database, sql, queryId);
        useStore.getState().setTabResult(tab.id, result);
        void notifyQueryFinished(origin, 'success', Date.now() - startedAt, summarizeResult(result));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Query failed';
        const raw = e instanceof Error ? (e as Error & { line?: number }).line : undefined;
        const line = raw === undefined ? undefined : raw + lineOffset;
        useStore.getState().setTabError(tab.id, line ? `Line ${line}: ${message}` : message);

        // Only the timeout. A rejected query already put its message in the results pane
        // with the user right there to read it, and a cancel was the user's own doing —
        // neither is news worth interrupting them for.
        if ((e as ApiError).code === QUERY_TIMEOUT) {
          void notifyQueryFinished(origin, 'timeout', Date.now() - startedAt, message);
        }
      }
    },
    [tab.id, tab.connectionId, tab.connectionName, tab.database, askConfirm, connType],
  );

  const runQuery = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;

    // One query per tab. The toolbar shows Stop rather than Run while one is in flight, but
    // F5, Ctrl+Enter and the Query menu all reach this directly — and a statement waiting on
    // a lock holds its pool connection the whole time, so a few impatient re-runs against a
    // blocked table can take every connection the pool has and leave the app with nothing
    // left to answer anything, the schema tree included.
    if (useStore.getState().tabs.find((t) => t.id === tab.id)?.isRunning) return;

    // Use the selected text when a non-empty selection exists; otherwise run everything.
    // Unchanged behaviour, deliberately: this is muscle memory. Run Statement (Query menu, F9)
    // is the new affordance and is kept entirely separate from it.
    const selection = selectionRef.current;
    const useSelection = selection !== null && !selection.isEmpty();
    const sql = useSelection
      ? (editor.getModel()?.getValueInRange(selection) ?? '')
      : editor.getValue();

    await runSql(sql, useSelection ? selection.startLineNumber - 1 : 0);
  }, [tab.id, runSql]);

  /**
   * Runs only the statement the caret is in — Query ▸ Run Statement (F9), the affordance every
   * Oracle client has. Reached only through the menu command; there is no toolbar button, so it
   * never competes with Run for space or meaning.
   *
   * Selecting the resolved range before running is deliberate: it is how the user sees what the
   * splitter thinks a statement is, so a misdetection is visible rather than mysterious.
   */
  const runStatement = useCallback(async () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const dialect = dialectFor(connType);
    if (!editor || !model || !dialect) return;
    if (useStore.getState().tabs.find((t) => t.id === tab.id)?.isRunning) return;

    const position = editor.getPosition();
    if (!position) return;
    const statement = statementAtOffset(
      splitSql(model.getValue(), dialect),
      model.getOffsetAt(position),
    );
    if (!statement) return;

    const from = model.getPositionAt(statement.start);
    const to = model.getPositionAt(statement.end);
    editor.setSelection({
      startLineNumber: from.lineNumber,
      startColumn: from.column,
      endLineNumber: to.lineNumber,
      endColumn: to.column,
    });

    await runSql(statement.text, from.lineNumber - 1);
  }, [tab.id, connType, runSql]);

  // Ask the server to cancel the in-flight query. The query promise above then
  // rejects with "Query cancelled" and lands in setTabError — nothing is committed.
  const stopQuery = useCallback(async () => {
    await cancelTabQuery(tabIdRef.current);
  }, []);

  const formatQuery = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const sql = editor.getValue();
    if (!sql.trim()) return;

    // Pick dialect from the saved connection so keywords/quoting match the server.
    const { savedConnections } = useStore.getState();
    const conn = savedConnections.find((c) => c.id === tab.connectionId);
    // sql-formatter doesn't understand Mongo shell syntax — nothing to format there
    // (the "⌥ Format" button is hidden for mongodb tabs, but guard anyway since this
    // is still reachable via the Shift+Alt+F keyboard shortcut).
    if (conn?.type === 'mongodb') return;
    const language =
      conn?.type === 'sqlserver' ? 'transactsql' : conn?.type === 'oracle' ? 'plsql' : 'postgresql';

    let formatted: string;
    try {
      formatted = format(sql, { language, tabWidth: 2, keywordCase: 'upper', linesBetweenQueries: 2 });
    } catch {
      // If sql-formatter can't parse the query (e.g. partial/invalid SQL) leave it unchanged.
      return;
    }

    // executeEdits keeps the change in Monaco's undo stack; setValue would clear it.
    editor.executeEdits('format', [{ range: model.getFullModelRange(), text: formatted }]);
    editor.focus();
  }, [tab.connectionId]);

  // Keep the refs in sync so the onKeyDown handler (registered once at mount) always
  // calls the latest callback version without needing to be re-registered.
  runQueryRef.current = runQuery;
  runStatementRef.current = runStatement;
  formatQueryRef.current = formatQuery;
  stopQueryRef.current = stopQuery;

  const handleEditorMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      editorRef.current = editor;

      // Expose this editor's live value so tab persistence can capture in-progress
      // edits when the user leaves the app (the editor is otherwise uncontrolled).
      registerEditor(tab.id, () => editor.getValue());

      // Persist edited SQL as the user types (debounced). This writes only to
      // localStorage via saveTabs — no Zustand set(), so it doesn't trigger the
      // React render cascade that onChange→store updates would. Relying on a
      // beforeunload flush alone proved unreliable, so content is saved live.
      let saveDebounce: ReturnType<typeof setTimeout> | null = null;
      editor.onDidChangeModelContent(() => {
        if (!useStore.getState().persistTabs) return;
        if (saveDebounce) clearTimeout(saveDebounce);
        saveDebounce = setTimeout(() => {
          const s = useStore.getState();
          saveTabs(s.tabs, s.activeTabId);
        }, 400);
      });

      // Use editor.onKeyDown() instead of editor.addCommand() for keyboard shortcuts.
      //
      // WHY: addCommand() registers keybindings in Monaco's GLOBAL keybinding service,
      // which is shared across all editor instances on the page. When multiple editors
      // register the same key (e.g. Cmd+Enter), the LAST registered handler always wins —
      // so Cmd+Enter always ran the most recently opened tab's query, regardless of which
      // tab was active. onKeyDown() is per-instance: it only fires for the editor that
      // currently has keyboard focus, which is exactly the behaviour we need.
      editor.onKeyDown((e) => {
        const isCmdEnter = (e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.Enter;
        const isShiftAltF = e.shiftKey && e.altKey && e.keyCode === monaco.KeyCode.KeyF;

        if (isCmdEnter) {
          e.preventDefault();
          e.stopPropagation();
          runQueryRef.current();
        } else if (isShiftAltF) {
          e.preventDefault();
          e.stopPropagation();
          formatQueryRef.current();
        }
      });

      // Keep selectionRef and hasSelection in sync so runQuery always has the
      // current selection without needing to be re-created as a dependency.
      editor.onDidChangeCursorSelection((e) => {
        const empty = e.selection.isEmpty();
        selectionRef.current = empty ? null : e.selection;
        setHasSelection(!empty);
      });

      // Register this editor's model → { connectionId, database } so completions use the right schema.
      // tab.connectionId and tab.database are constant for the lifetime of a tab, so the closure is safe.
      const modelUri = editor.getModel()?.uri.toString();
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (modelUri) modelConnectionMap.set(modelUri, { connectionId: tab.connectionId, database: tab.database });

      if (!completionRegistered) {
        completionRegistered = true;
        monaco.languages.registerCompletionItemProvider('sql', {
          // '.' triggers column completions after a table name (table.█)
          // '"' triggers identifier completions when the user opens a quote manually
          triggerCharacters: ['.', '"'],
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position);
            const baseRange = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };

            // If the character immediately before the current word is an opening
            // quote that the user typed manually ("  or  [), extend the replacement
            // range to cover it. Without this, accepting a quoted completion like
            // "users" would leave the user's " in place and produce ""users".
            const charBefore = word.startColumn > 1
              ? model.getValueInRange({
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn - 1,
                  endColumn: word.startColumn,
                })
              : '';
            const hasOpenQuote = charBefore === '"' || charBefore === '[';
            // identRange is used for table/column completions; keywords use baseRange.
            const identRange = hasOpenQuote
              ? { ...baseRange, startColumn: baseRange.startColumn - 1 }
              : baseRange;

            // ── Schema look-up ────────────────────────────────────────────────
            const modelInfo = modelConnectionMap.get(model.uri.toString());
            const { activeConnections, savedConnections } = useStore.getState();
            const schema = modelInfo
              ? activeConnections[modelInfo.connectionId]?.schemas[modelInfo.database]?.schema ?? null
              : null;

            // Identifier quoting: PostgreSQL needs "Name" to preserve case,
            // SQL Server uses [Name]. Fall back to unquoted if type unknown.
            const connId = modelInfo?.connectionId;
            const connType = savedConnections.find((c) => c.id === connId)?.type;
            const q = connType === 'sqlserver'
              ? (n: string) => `[${n}]`
              : (n: string) => `"${n}"`; // postgres default

            // Flatten schema into usable lists
            type TableEntry  = { name: string; schemaName: string };
            type ColumnEntry = { name: string; type: string; tableName: string };
            const tables: TableEntry[] = [];
            const allColumns: ColumnEntry[] = [];
            const tableColMap = new Map<string, ColumnEntry[]>();

            if (schema) {
              for (const db of schema.databases) {
                for (const sNode of db.schemas) {
                  for (const tNode of sNode.tables) {
                    tables.push({ name: tNode.name, schemaName: sNode.name });
                    const cols: ColumnEntry[] = tNode.columns.map((c) => ({
                      name: c.name,
                      type: c.type,
                      tableName: tNode.name,
                    }));
                    tableColMap.set(tNode.name.toLowerCase(), cols);
                    allColumns.push(...cols);
                  }
                }
              }
            }

            // ── Context detection ─────────────────────────────────────────────
            // Full text from start of document to the cursor position
            const textBefore = model.getValueInRange({
              startLineNumber: 1,
              endLineNumber: position.lineNumber,
              startColumn: 1,
              endColumn: position.column,
            });
            const fullText = model.getValue();

            // Build alias → real table name map so "alias." completions work.
            // Pattern: FROM/JOIN tableName [AS] alias
            // SQL keywords that can legally follow a table name are excluded as aliases.
            const SQL_KW = new Set([
              'where', 'on', 'set', 'and', 'or', 'not', 'group', 'order', 'having',
              'limit', 'offset', 'union', 'except', 'intersect', 'inner', 'left',
              'right', 'cross', 'join', 'select', 'from', 'into', 'update', 'insert',
              'delete', 'create', 'drop', 'alter', 'as',
            ]);
            const aliasToTable = new Map<string, string>();
            const aliasRe = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|UPDATE|INTO)\s+(?:(?:"?\w+"?|`\w+`|\[\w+\])\s*\.\s*)?(?:"(\w+)"|`(\w+)`|\[(\w+)\]|(\w+))(?:\s+(?:AS\s+)?(\w+))?/gi;
            let am: RegExpExecArray | null;
            while ((am = aliasRe.exec(fullText)) !== null) {
              const tName = (am[1] ?? am[2] ?? am[3] ?? am[4] ?? '').toLowerCase();
              const alias = am[5]?.toLowerCase();
              if (tName && alias && !SQL_KW.has(alias)) {
                aliasToTable.set(alias, tName);
              }
            }

            // "tableName." / alias. / `"tableName".` / `[tableName].` → columns of that table.
            // Resolves through aliasToTable so "ti." works when the query has "TiposItem" ti.
            const dotMatch = textBefore.match(/(?:"(\w+)"|`(\w+)`|\[(\w+)\]|(\w+))\.\w*$/);
            if (dotMatch) {
              const ref = (dotMatch[1] ?? dotMatch[2] ?? dotMatch[3] ?? dotMatch[4] ?? '').toLowerCase();
              const resolvedTable = tableColMap.has(ref) ? ref : (aliasToTable.get(ref) ?? ref);
              const cols = tableColMap.get(resolvedTable) ?? [];
              return {
                suggestions: cols.map((col) => ({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name,
                  detail: col.type,
                  sortText: col.name,
                  range: baseRange,
                })),
              };
            }

            // After FROM / JOIN / UPDATE / INTO → tables should sort to the top
            const isTableCtx = /\b(FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|UPDATE|INTO)\s+\w*$/i
              .test(textBefore);

            // ── Build suggestion list ─────────────────────────────────────────
            const suggestions: Monaco.languages.CompletionItem[] = [];

            // SQL keywords
            const keywords = [
              'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
              'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
              'INSERT INTO', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'DROP TABLE',
              'ALTER TABLE', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE',
              'NULLIF', 'CAST', 'AS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'NOT IN', 'EXISTS',
              'NOT EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL',
              'CASE WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL', 'INTERSECT',
              'EXCEPT', 'WITH', 'RETURNING', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
            ];
            suggestions.push(
              ...keywords.map((k) => ({
                label: k,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: k,
                // In table context, keywords sort below tables; otherwise above columns
                sortText: isTableCtx ? `2_${k}` : `1_${k}`,
                range: baseRange,
              }))
            );

            // Table names — insertText is always quoted so case is preserved exactly
            suggestions.push(
              ...tables.map((t) => ({
                label: t.name,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: q(t.name),
                detail: t.schemaName,
                documentation: { value: `Table in schema **${t.schemaName}**` },
                // In table context sort first; otherwise after keywords but before columns
                sortText: isTableCtx ? `0_${t.name}` : `2_${t.name}`,
                range: identRange,
              }))
            );

            // Column names — only from tables already mentioned in the query.
            // fullText and aliasToTable are already built above.
            if (!isTableCtx) {
              // Matches: FROM/JOIN/etc [optional schema.] tableName (quoted or unquoted)
              const tableRefRe = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|UPDATE|INTO)\s+(?:(?:"?\w+"?|`\w+`|\[\w+\])\s*\.\s*)?(?:"(\w+)"|`(\w+)`|\[(\w+)\]|(\w+))/gi;
              const referencedTables = new Set<string>();
              let m: RegExpExecArray | null;
              while ((m = tableRefRe.exec(fullText)) !== null) {
                const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
                if (name) referencedTables.add(name);
              }

              // Only suggest columns when at least one table is referenced;
              // filter to just those tables so unrelated columns don't appear.
              if (referencedTables.size > 0) {
                const scopedColumns = allColumns.filter((col) =>
                  referencedTables.has(col.tableName.toLowerCase())
                );
                suggestions.push(
                  ...scopedColumns.map((col) => ({
                    label: col.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: col.name,
                    detail: `${col.tableName}  ${col.type}`,
                    sortText: `3_${col.name}`,
                    range: baseRange,
                  }))
                );
              }
            }

            return { suggestions };
          },
        });
      }

      // MongoDB shell-syntax completions: collection names after "db.", methods
      // after "db.<collection>.", and cursor modifiers after a chained call's ")."
      // Registered once for the 'javascript' language (used by Mongo tabs); the
      // provider itself checks the connection type per-model and no-ops otherwise.
      if (!mongoCompletionRegistered) {
        mongoCompletionRegistered = true;
        monaco.languages.registerCompletionItemProvider('javascript', {
          triggerCharacters: ['.'],
          provideCompletionItems: (model, position) => {
            const modelInfo = modelConnectionMap.get(model.uri.toString());
            const { activeConnections, savedConnections } = useStore.getState();
            const connType = modelInfo
              ? savedConnections.find((c) => c.id === modelInfo.connectionId)?.type
              : undefined;
            if (!modelInfo || connType !== 'mongodb') return { suggestions: [] };

            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            const textBefore = model.getValueInRange({
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: 1,
              endColumn: position.column,
            });

            const snippetItem = (
              m: { name: string; snippet: string; detail: string }
            ): Monaco.languages.CompletionItem => ({
              label: m.name,
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: m.snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: m.detail,
              range,
            });

            // After a closed call + '.' — e.g. db.users.find({}).█ — offer chain modifiers.
            if (/\)\s*\.\s*\w*$/.test(textBefore)) {
              return { suggestions: MONGO_CHAIN_METHODS.map(snippetItem) };
            }

            // After db.<collection>.█ — offer the supported operations.
            if (/\bdb\s*\.\s*[\w$]+\s*\.\s*\w*$/.test(textBefore)) {
              return { suggestions: MONGO_METHODS.map(snippetItem) };
            }

            // Right after db.█ — offer this database's collection names.
            if (/\bdb\s*\.\s*\w*$/.test(textBefore)) {
              const schema = activeConnections[modelInfo.connectionId]?.schemas[modelInfo.database]?.schema;
              const collections = schema?.databases[0]?.schemas[0]?.tables ?? [];
              return {
                suggestions: collections.map((t) => ({
                  label: t.name,
                  kind: monaco.languages.CompletionItemKind.Class,
                  insertText: t.name,
                  detail: 'collection',
                  range,
                })),
              };
            }

            return { suggestions: [] };
          },
        });
      }
    },
    // No dependencies: all mutable state is accessed via refs (runQueryRef, formatQueryRef,
    // selectionRef, editorRef). The function is created once and never needs to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Stable options object — prevents @monaco-editor/react from calling
  // editor.updateOptions() on every parent re-render.
  const editorOptions = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    minimap: { enabled: false },
    lineNumbers: 'on',
    renderLineHighlight: 'gutter',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    padding: { top: 12, bottom: 12 },
    suggest: { showKeywords: true },
    tabSize: 2,
    formatOnPaste: true,
    automaticLayout: true,
  }), []);

  return (
    <div className="flex flex-col h-full">
      {/* The actions must never shrink or wrap: with a wide Ask AI panel open this row used
          to overflow its column, and the spilled buttons painted on top of the panel — an
          earlier sibling's inline content draws above a later sibling's background. The
          breadcrumb gives up its space instead, and truncates once it runs out. */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-2 bg-surface flex-shrink-0 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <span className="text-xs text-text-muted truncate" title={tab.connectionName}>
            {tab.connectionName}
          </span>
          <span className="text-xs text-text-dim flex-shrink-0">/</span>
          <span className="text-xs text-text truncate" title={tab.database}>
            {tab.database}
          </span>
          {!isConnected && (
            <span className="text-xs text-warning bg-warning/10 px-2 py-0.5 rounded flex-shrink-0">
              disconnected
            </span>
          )}
          {tab.fromAi && (
            <span className="flex items-center gap-1 text-[11px] text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded flex-shrink-0 whitespace-nowrap">
              <SparkleIcon className="w-2.5 h-2.5 flex-shrink-0" />
              AI-generated · not run yet
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0" />
        <button
          className={`btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap ${
            aiPanelOpen ? 'text-text border-accent' : ''
          }`}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
          title="Ask AI to write a query from your schema"
        >
          <SparkleIcon className="w-3 h-3 text-accent" />
          Ask AI
        </button>
        {connType !== 'mongodb' && (
          <button
            className="btn-ghost text-xs px-3 py-1.5 flex-shrink-0 whitespace-nowrap"
            onClick={formatQuery}
            disabled={isRunning}
            title="Format SQL (Shift+Alt+F)"
          >
            ⌥ Format
          </button>
        )}
        {isRunning ? (
          <button
            className="text-xs px-3 py-1.5 flex items-center gap-1.5 rounded bg-error/90 hover:bg-error text-white flex-shrink-0 whitespace-nowrap"
            onClick={stopQuery}
            title="Stop the running query (nothing is committed)"
          >
            <span className="inline-block w-2.5 h-2.5 bg-white rounded-sm" />
            Stop
          </button>
        ) : (
          <button
            className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50 flex-shrink-0 whitespace-nowrap"
            onClick={runQuery}
            disabled={!isConnected}
            title={hasSelection ? 'Run selected text (Ctrl+Enter / F5)' : 'Run query (Ctrl+Enter / F5)'}
          >
            {hasSelection ? <>▶ Run Selection</> : <>▶ Run</>}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        <MonacoEditor
          height="100%"
          language={connType === 'mongodb' ? 'javascript' : 'sql'}
          defaultValue={tab.sql}
          theme="vs-dark"
          onMount={handleEditorMount}
          options={editorOptions}
        />
      </div>

      {confirmMessage && (
        <ConfirmDialog
          title="Run without a WHERE clause?"
          message={confirmMessage}
          confirmLabel="Execute anyway"
          cancelLabel="Cancel"
          danger
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      )}
    </div>
  );
}, tabPropsEqual);
