import { splitSql, SqlDialect } from './splitSql';
import type { SchemaTree } from './types';

// Shared with the renderer. Keep this module independent of drivers and Monaco so incomplete
// queries can be tested without a database or editor instance.
interface Token {
  text: string;
  start: number;
  end: number;
  kind: 'identifier' | 'symbol' | 'literal' | 'comment';
  quoted?: boolean;
  closed?: boolean;
}

interface Reference {
  parts: Token[];
  alias?: Token;
}

export interface CompletionTable {
  database: string;
  schema: string;
  name: string;
  columns: { name: string; type: string }[];
}

export interface CompletionColumn {
  name: string;
  type: string;
  table: CompletionTable;
  qualifier: string[];
}

export interface SqlCompletionContext {
  tables: CompletionTable[];
  columns: CompletionColumn[];
  tableContext: boolean;
  qualified: boolean;
  suppressed: boolean;
  replaceStart: number;
  replaceEnd: number;
}

const keyword = (token: Token | undefined, word: string) =>
  token?.kind === 'identifier' && !token.quoted && token.text.toUpperCase() === word;

// These cannot be implicit aliases. Quoted identifiers are always allowed.
const RESERVED = new Set(('SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING '
  + 'GROUP ORDER BY HAVING LIMIT OFFSET FETCH UNION EXCEPT INTERSECT RETURNING SET VALUES '
  + 'INSERT UPDATE DELETE INTO AS AND OR NOT WITH RECURSIVE WINDOW QUALIFY FOR CONNECT START '
  + 'PIVOT UNPIVOT TABLESAMPLE APPLY WHEN MATCHED THEN ELSE END').split(' '));

function identifier(token: Token | undefined): token is Token {
  return token?.kind === 'identifier' && (!!token.quoted || !RESERVED.has(token.text.toUpperCase()));
}

function tokenize(sql: string, dialect: SqlDialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    const start = i;
    let kind: Token['kind'] = 'symbol';
    let quoted = false;
    let closed = true;
    let text = '';
    if (sql.startsWith('--', i)) {
      kind = 'comment';
      while (i < sql.length && sql[i] !== '\n') i++;
      closed = false;
    } else if (sql.startsWith('/*', i)) {
      kind = 'comment';
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (dialect === 'postgres' && sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      closed = depth === 0;
    } else if (dialect === 'postgres' && /^\$(?:[A-Za-z_][\w$]*?)?\$/.test(sql.slice(i))) {
      kind = 'literal';
      const delimiter = /^\$(?:[A-Za-z_][\w$]*?)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(delimiter, i + delimiter.length);
      closed = end !== -1;
      i = closed ? end + delimiter.length : sql.length;
    } else if (dialect === 'oracle' && /^[qQ]'./.test(sql.slice(i))) {
      kind = 'literal';
      const open = sql[i + 2];
      const close = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open;
      const end = sql.indexOf(close + "'", i + 3);
      closed = end !== -1;
      i = closed ? end + 2 : sql.length;
    } else if (sql[i] === "'" || sql[i] === '"' || (dialect === 'sqlserver' && sql[i] === '[')) {
      const open = sql[i++];
      const close = open === '[' ? ']' : open;
      kind = open === "'" ? 'literal' : 'identifier';
      quoted = kind === 'identifier';
      closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          i++;
          if (sql[i] !== close) { closed = true; break; }
        } else if (kind === 'literal' && dialect === 'postgres' && sql[i] === '\\'
          && /(?:^|\W)[eE]$/.test(sql.slice(0, start))) {
          text += sql[i++];
          if (i >= sql.length) break;
        }
        text += sql[i++];
      }
    } else if (/[\p{L}_#]/u.test(sql[i])) {
      kind = 'identifier';
      while (i < sql.length && /[\p{L}\p{N}_$#]/u.test(sql[i])) text += sql[i++];
    } else {
      text = sql[i++];
    }
    tokens.push({ text, start, end: i, kind, quoted, closed });
  }
  return tokens;
}

function matches(name: string, token: Token, dialect: SqlDialect): boolean {
  // SQL Server identifier sensitivity depends on collation, which schema metadata does not
  // expose. Retain its case-insensitive behavior; preserve quoted case for PostgreSQL/Oracle.
  if (dialect === 'sqlserver') return name.toLowerCase() === token.text.toLowerCase();
  return name === (token.quoted ? token.text
    : dialect === 'oracle' ? token.text.toUpperCase() : token.text.toLowerCase());
}

function identifierName(token: Token, dialect: SqlDialect): string {
  if (dialect === 'sqlserver') return token.text.toLowerCase();
  return token.quoted ? token.text : dialect === 'oracle' ? token.text.toUpperCase() : token.text.toLowerCase();
}

function pathAt(tokens: Token[], start: number): { parts: Token[]; next: number } {
  const parts: Token[] = [];
  let next = start;
  if (!identifier(tokens[next])) return { parts, next };
  parts.push(tokens[next++]);
  while (tokens[next]?.text === '.' && identifier(tokens[next + 1])) {
    parts.push(tokens[next + 1]);
    next += 2;
  }
  return { parts, next };
}

/**
 * Scope completions to the active statement and its innermost query parentheses. This is a
 * tolerant lexical resolver, not a SQL validator: CTE/derived-table projections are not inferred.
 * Ambiguous physical tables are deliberately left unresolved instead of guessing a search path.
 */
export function sqlCompletionContext(
  sql: string, offset: number, dialect: SqlDialect, schema: SchemaTree | null,
): SqlCompletionContext {
  const tables: CompletionTable[] = [];
  for (const db of schema?.databases ?? []) {
    for (const s of db.schemas) {
      for (const t of s.tables) tables.push({ database: db.name, schema: s.name, name: t.name, columns: t.columns });
    }
  }
  const result: SqlCompletionContext = {
    tables, columns: [], tableContext: false, qualified: false, suppressed: false,
    replaceStart: offset, replaceEnd: offset,
  };
  const allTokens = tokenize(sql, dialect);
  result.suppressed = allTokens.some(t => (t.kind === 'literal' || t.kind === 'comment')
    && offset > t.start && (offset < t.end || (offset === t.end && !t.closed)));
  if (result.suppressed) return result;

  // Unlike Run Statement, never select the next/previous statement across a delimiter.
  // Trailing whitespace still belongs to an unfinished statement (e.g. "WHERE ").
  const statement = splitSql(sql, dialect).find(s => s.start <= offset
    && (offset <= s.end || /^\s*$/.test(sql.slice(s.end, offset))));
  if (!statement || statement.block) return result;
  const tokens = allTokens.filter(t => t.start >= statement.start && t.start < Math.max(statement.end, offset)
    && t.kind !== 'comment');

  const current = tokens.find(t => t.kind === 'identifier' && t.start < offset && t.end >= offset);
  if (current) { result.replaceStart = current.start; result.replaceEnd = current.end; }
  const before = tokens.filter(t => t.end <= result.replaceStart);
  const qualifier: Token[] = [];
  for (let i = before.length - 1; i >= 1 && before[i].text === '.' && identifier(before[i - 1]); i -= 2) {
    qualifier.unshift(before[i - 1]);
  }
  result.qualified = qualifier.length > 0;
  const previous = before[before.length - 1 - qualifier.length * 2];
  result.tableContext = ['FROM', 'JOIN', 'UPDATE', 'INTO', 'APPLY'].some(k => keyword(previous, k));
  if (previous?.kind === 'symbol' && previous.text === ',') {
    let depth = 0;
    for (let i = before.length - 2 - qualifier.length * 2; i >= 0; i--) {
      const t = before[i];
      if (t.kind === 'symbol' && t.text === ')') depth++;
      else if (t.kind === 'symbol' && t.text === '(') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && ['FROM', 'JOIN', 'WHERE', 'ON', 'SELECT', 'ORDER', 'GROUP'].some(k => keyword(t, k))) {
        result.tableContext = keyword(t, 'FROM') || keyword(t, 'JOIN');
        break;
      }
    }
  }
  if (result.tableContext) {
    if (qualifier.length) result.tables = tables.filter(t => matches(t.schema, qualifier[qualifier.length - 1], dialect)
      && (qualifier.length < 2 || matches(t.database, qualifier[qualifier.length - 2], dialect)));
    return result;
  }

  // Parenthesis groups let function arguments inherit the surrounding query while a SELECT
  // inside parentheses gets its own table scope. Sibling subqueries never share aliases.
  interface Group { parent?: Group; tokens: Token[]; start: number; end: number; isolated?: boolean }
  const root: Group = { tokens: [], start: statement.start, end: Math.max(statement.end, offset) };
  const groups = [root];
  let group = root;
  for (const token of tokens) {
    if (token.text === '(' && token.kind === 'symbol') {
      const previous = group.tokens[group.tokens.length - 1];
      // CTE bodies and ordinary derived tables cannot see the containing query's FROM.
      // LATERAL/APPLY are intentionally allowed to inherit it.
      const precedingClause = [...group.tokens].reverse().find(t =>
        ['FROM', 'JOIN', 'SELECT', 'WHERE', 'ON'].some(k => keyword(t, k)));
      const isolated = ['AS', 'MATERIALIZED', 'FROM', 'JOIN'].some(k => keyword(previous, k))
        || (previous?.kind === 'symbol' && previous.text === ','
          && (keyword(precedingClause, 'FROM') || keyword(precedingClause, 'JOIN')));
      group.tokens.push(token);
      group = { parent: group, tokens: [], start: token.end, end: root.end, isolated };
      groups.push(group);
    } else if (token.text === ')' && token.kind === 'symbol' && group.parent) {
      group.end = token.start;
      group = group.parent;
      group.tokens.push(token);
    } else group.tokens.push(token);
  }
  const isQuery = (g: Group) => g === root || g.tokens.some(t => keyword(t, 'SELECT'));
  let active = groups.filter(g => g.start <= offset && offset <= g.end).pop() ?? root;
  while (!isQuery(active) && active.parent) active = active.parent;

  // WITH names shadow physical tables. Until projection inference is implemented, offer no
  // fields for them rather than borrowing columns from a same-named catalog table.
  const cteNames: Token[] = [];
  for (let g: Group | undefined = active; g; g = g.parent) {
    if (!keyword(g.tokens[0], 'WITH')) continue;
    let i = keyword(g.tokens[1], 'RECURSIVE') ? 2 : 1;
    while (identifier(g.tokens[i])) {
      const name = g.tokens[i++];
      if (g.tokens[i]?.text === '(' && g.tokens[i + 1]?.text === ')') i += 2;
      if (!keyword(g.tokens[i++], 'AS')) break;
      if (keyword(g.tokens[i], 'NOT')) i++;
      if (keyword(g.tokens[i], 'MATERIALIZED')) i++;
      if (g.tokens[i]?.text !== '(' || g.tokens[i + 1]?.text !== ')') break;
      cteNames.push(name);
      i += 2;
      if (g.tokens[i++]?.text !== ',') break;
    }
  }

  const references: Reference[] = [];
  const seenAliases: Token[] = [];
  // Include enclosing query references for correlated subqueries. The nearest alias wins.
  for (let scope: Group | undefined = active; scope; scope = scope.isolated ? undefined : scope.parent) {
    if (!isQuery(scope)) continue;
    let local = scope.tokens;
    // UNION/EXCEPT/INTERSECT branches have separate FROM clauses even without parentheses.
    const separators = local.filter(t => ['UNION', 'EXCEPT', 'INTERSECT'].some(k => keyword(t, k)));
    const left = separators.filter(t => t.start < offset).pop()?.end ?? scope.start;
    const right = separators.find(t => t.start >= offset)?.start ?? scope.end;
    local = local.filter(t => t.start >= left && t.start < right);
    let fromList = false;
    for (let i = 0; i < local.length; i++) {
      const token = local[i];
      const introduces = ['FROM', 'JOIN', 'UPDATE', 'INTO', 'APPLY'].some(k => keyword(token, k));
      if (keyword(token, 'FROM')) fromList = true;
      else if (['WHERE', 'GROUP', 'ORDER', 'HAVING', 'SET', 'VALUES', 'RETURNING', 'ON'].some(k => keyword(token, k))) fromList = false;
      if (!introduces && !(fromList && token.text === ',')) continue;
      const path = pathAt(local, i + 1);
      let next = path.next;
      // Skip derived tables and table-valued functions, but record their aliases to shadow
      // outer bindings. Their result columns require projection/return-type metadata.
      const derived = local[next]?.text === '(';
      if (derived) {
        next++;
        if (local[next]?.text === ')') next++;
      }
      if (keyword(local[next], 'AS')) next++;
      const alias = identifier(local[next]) ? local[next] : undefined;
      // SQL Server's UPDATE alias ... FROM table alias binds through FROM. The target must
      // not consume that alias before we reach the actual table reference.
      if (keyword(token, 'UPDATE') && !alias && path.parts.length === 1
        && local.some(t => keyword(t, 'FROM')) && !tables.some(t => matches(t.name, path.parts[0], dialect))) continue;
      const binding = alias ?? path.parts[path.parts.length - 1];
      if (!binding || seenAliases.some(a => identifierName(a, dialect) === identifierName(binding, dialect))) continue;
      seenAliases.push(binding);
      if (!derived && path.parts.length && !(path.parts.length === 1
        && cteNames.some(c => identifierName(c, dialect) === identifierName(path.parts[0], dialect)))) {
        references.push({ parts: path.parts, alias });
      }
      i = Math.max(i, next - 1);
    }
  }

  for (const ref of references) {
    if (qualifier.length) {
      const binding = ref.alias ? [ref.alias] : ref.parts;
      if (qualifier.length > binding.length || !qualifier.every((q, i) => {
        const b = binding[binding.length - qualifier.length + i];
        const name = b.quoted || dialect === 'sqlserver' ? b.text
          : dialect === 'oracle' ? b.text.toUpperCase() : b.text.toLowerCase();
        return matches(name, q, dialect);
      })) continue;
    }
    const parts = ref.parts;
    const candidates = tables.filter(t => matches(t.name, parts[parts.length - 1], dialect)
      && (parts.length < 2 || matches(t.schema, parts[parts.length - 2], dialect))
      && (parts.length < 3 || matches(t.database, parts[parts.length - 3], dialect)));
    if (candidates.length !== 1) continue;
    const table = candidates[0];
    const binding = ref.alias;
    const insertionQualifier = binding
      ? [binding.quoted || dialect === 'sqlserver' ? binding.text
        : dialect === 'oracle' ? binding.text.toUpperCase() : binding.text.toLowerCase()]
      : [table.schema, table.name];
    result.columns.push(...table.columns.map(c => ({ ...c, table, qualifier: insertionQualifier })));
  }
  return result;
}

// PostgreSQL 18 keywords that cannot be bare column/table names (RESERVED_KEYWORD and
// TYPE_FUNC_NAME_KEYWORD). Unlike the scope scanner's RESERVED set, ordinary keywords such
// as "value", "type", and "between" are valid identifiers here.
// https://www.postgresql.org/docs/18/sql-keywords-appendix.html
const POSTGRES_RESERVED_IDENTIFIERS = new Set((
  'all analyse analyze and any array as asc asymmetric authorization binary both case cast '
  + 'check collate collation column concurrently constraint create cross current_catalog current_date '
  + 'current_role current_schema current_time current_timestamp current_user default deferrable desc '
  + 'distinct do else end except false fetch for foreign freeze from full grant group having ilike '
  + 'in initially inner intersect into is isnull join lateral leading left like limit localtime '
  + 'localtimestamp natural not notnull null offset on only or order outer overlaps placing primary '
  + 'references returning right select session_user similar some symmetric system_user table tablesample '
  + 'then to trailing true union unique user using variadic verbose when where window with'
).split(' '));

/** Catalog spelling, rather than the table's quoting, determines whether a column needs quotes. */
export function quoteSqlIdentifier(name: string, dialect: SqlDialect, forceQuote = false): string {
  if (dialect === 'postgres' && !forceQuote && name === name.toLowerCase()
    && /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(name) && !POSTGRES_RESERVED_IDENTIFIERS.has(name)) return name;
  return dialect === 'sqlserver' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}
