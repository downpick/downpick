/**
 * Splits a script into the statements a driver may send one at a time, as CHARACTER RANGES.
 *
 * Ranges rather than strings because both callers have to map back into the editor the user is
 * looking at: "Run Statement" (F9) maps a cursor offset onto a statement, and the Oracle driver
 * translates the offset in a failure back into a line of the whole script. A list of strings
 * throws that information away and cannot get it back.
 *
 * ZERO IMPORTS, deliberately. This file is compiled into the main process by
 * electron/tsconfig.json AND bundled into the renderer by Vite, exactly the way channels.ts is
 * (see client/src/api.ts). Importing anything that reaches `node:` or a database driver would
 * pull that package into the browser bundle.
 */

/** No 'generic' member: every caller knows its engine, and a default would hide a wrong answer. */
export type SqlDialect = 'oracle' | 'postgres' | 'sqlserver';

export interface SqlStatement {
  /**
   * INVARIANT: text === sql.slice(start, end). Trimming happens by moving `start`/`end`, never
   * by rewriting the string — the moment those disagree, every offset derived from `start` is
   * silently wrong, which is the one bug this module cannot afford.
   */
  text: string;
  /** Offset of the first character, inclusive. */
  start: number;
  /** Offset one past the last character, exclusive. */
  end: number;
  /** Uppercased leading keyword ('SELECT', 'BEGIN', 'CREATE'); '' when none was found. */
  verb: string;
  /** True when this was recognised as a PL/SQL block, i.e. its inner `;` were not separators. */
  block: boolean;
}

interface DialectRules {
  /** PostgreSQL nests block comments. Oracle and SQL Server do not. */
  nestedBlockComments: boolean;
  /** SQL Server's [bracketed identifier], with ]] escaping. */
  bracketIdentifiers: boolean;
  /** PostgreSQL $tag$ ... $tag$ and $$ ... $$. */
  dollarQuoting: boolean;
  /** Oracle q'[...]' / Q'!...!'. */
  alternativeQuoting: boolean;
  /** Oracle: a `/` alone on its own line terminates whatever is open. */
  slashTerminator: boolean;
  /** SQL Server: a `GO` alone on its own line ends a batch. */
  goSeparator: boolean;
  /** Oracle: recognise PL/SQL block starts so their inner `;` do not split. */
  plsqlBlocks: boolean;
}

const RULES: Record<SqlDialect, DialectRules> = {
  oracle: {
    nestedBlockComments: false,
    bracketIdentifiers: false,
    dollarQuoting: false,
    alternativeQuoting: true,
    slashTerminator: true,
    goSeparator: false,
    plsqlBlocks: true,
  },
  postgres: {
    nestedBlockComments: true,
    bracketIdentifiers: false,
    dollarQuoting: true,
    alternativeQuoting: false,
    slashTerminator: false,
    goSeparator: false,
    plsqlBlocks: false,
  },
  sqlserver: {
    nestedBlockComments: false,
    bracketIdentifiers: true,
    dollarQuoting: false,
    alternativeQuoting: false,
    slashTerminator: false,
    goSeparator: true,
    plsqlBlocks: false,
  },
};

/** Oracle allows $ and # inside unquoted identifiers, so they are word characters here. */
function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$#]/.test(c);
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v';
}

/** Closing delimiter for an Oracle alternative-quote opener. Paired brackets mirror; else self. */
function altQuoteClose(open: string): string {
  switch (open) {
    case '[': return ']';
    case '{': return '}';
    case '(': return ')';
    case '<': return '>';
    default: return open;
  }
}

/** True when everything between the previous newline and `i`, and `i`+len to the next, is blank. */
function aloneOnLine(sql: string, i: number, len: number): boolean {
  for (let j = i - 1; j >= 0 && sql[j] !== '\n'; j--) {
    if (!isSpace(sql[j])) return false;
  }
  for (let j = i + len; j < sql.length && sql[j] !== '\n'; j++) {
    if (!isSpace(sql[j])) return false;
  }
  return true;
}

/**
 * Skips whitespace and comments from `i`, returning the next significant offset.
 *
 * Shared by the main scanner and the block detector so the two can never disagree about what
 * counts as significant — a disagreement there would make block detection read tokens the
 * scanner does not.
 */
function skipTrivia(sql: string, i: number, rules: DialectRules): number {
  for (;;) {
    while (i < sql.length && isSpace(sql[i])) i++;
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (rules.nestedBlockComments && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    return i;
  }
}

/**
 * Reads up to `max` significant word tokens, uppercased, starting at `from`.
 *
 * `<<label>>` prefixes are stepped over: a labelled block is still a block, and the label is
 * never one of the keywords the seeds below match on.
 */
function peekTokens(sql: string, from: number, max: number, rules: DialectRules): string[] {
  const tokens: string[] = [];
  let i = skipTrivia(sql, from, rules);
  if (sql[i] === '<' && sql[i + 1] === '<') {
    const close = sql.indexOf('>>', i + 2);
    i = close === -1 ? sql.length : skipTrivia(sql, close + 2, rules);
  }
  while (tokens.length < max && i < sql.length) {
    if (!isWordChar(sql[i])) break;
    const start = i;
    while (i < sql.length && isWordChar(sql[i])) i++;
    tokens.push(sql.slice(start, i).toUpperCase());
    i = skipTrivia(sql, i, rules);
  }
  return tokens;
}

/** Noise words between CREATE and the object kind. FORCE/NO belong to VIEW, not to a block. */
const CREATE_NOISE = new Set(['OR', 'REPLACE', 'EDITIONABLE', 'NONEDITIONABLE', 'FORCE', 'NO']);
/** Kinds whose body supplies its own BEGIN, so the seed waits for it. */
const PENDING_BODY_KINDS = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'LIBRARY']);

interface BlockSeed {
  block: boolean;
  depth: number;
  /** Suppress `;` splitting until depth has risen above 0 and come back down. */
  pendingBody: boolean;
}

const NOT_A_BLOCK: BlockSeed = { block: false, depth: 0, pendingBody: false };

/**
 * Decides once, at statement start, whether this statement is a PL/SQL block.
 *
 * A bounded look at five tokens, then frozen — this is a heuristic, not a parser, and keeping
 * the decision bounded is what stops it from drifting into being one. The lone-`/` rule in the
 * scanner is the backstop for the cases it gets wrong.
 */
function detectBlock(sql: string, from: number, rules: DialectRules): BlockSeed {
  if (!rules.plsqlBlocks) return NOT_A_BLOCK;
  const t = peekTokens(sql, from, 5, rules);
  if (t.length === 0) return NOT_A_BLOCK;

  if (t[0] === 'DECLARE' || t[0] === 'BEGIN') {
    // The BEGIN token itself raises depth to 1 when the scanner reaches it.
    return { block: true, depth: 0, pendingBody: true };
  }

  // ALTER PROCEDURE ... COMPILE is a plain statement. ALTER never opens a block.
  if (t[0] !== 'CREATE') return NOT_A_BLOCK;

  let k = 1;
  while (k < t.length && CREATE_NOISE.has(t[k])) k++;
  const kind = t[k];
  if (kind === undefined) return NOT_A_BLOCK;

  // A package spec or body opens a declarative region that a matching END closes with no
  // BEGIN in between, so it seeds at 1 rather than waiting for a body.
  if (kind === 'PACKAGE') return { block: true, depth: 1, pendingBody: false };
  // CREATE TYPE BODY is a block; bare CREATE TYPE ... AS OBJECT (...) is a plain statement.
  if (kind === 'TYPE') {
    return t[k + 1] === 'BODY' ? { block: true, depth: 1, pendingBody: false } : NOT_A_BLOCK;
  }
  if (PENDING_BODY_KINDS.has(kind)) return { block: true, depth: 0, pendingBody: true };
  return NOT_A_BLOCK;
}

/**
 * Openers tracked inside a block. PROCEDURE/FUNCTION declarations are NOT openers — a package
 * body seeds at 1 and its nested routines balance their own BEGIN/END, so counting them too
 * would leave the outermost END unmatched.
 */
const DEPTH_OPENERS = new Set(['BEGIN', 'IF', 'CASE', 'LOOP']);

/**
 * Splits `sql` into executable statements.
 *
 * Never throws and never returns an empty `text`: half-typed input is the normal case in an
 * editor, and F9 has to keep working while the user is still typing.
 */
export function splitSql(sql: string, dialect: SqlDialect): SqlStatement[] {
  const rules = RULES[dialect];
  const out: SqlStatement[] = [];
  const n = sql.length;

  let i = 0;
  let stmtStart = -1;
  let seed: BlockSeed = NOT_A_BLOCK;
  let depth = 0;
  let pendingBody = false;

  const reset = () => {
    stmtStart = -1;
    seed = NOT_A_BLOCK;
    depth = 0;
    pendingBody = false;
  };

  /** Emits [stmtStart, end). Trims trailing blanks by MOVING `end`, preserving the invariant. */
  const emit = (end: number) => {
    let stop = end;
    while (stop > stmtStart && isSpace(sql[stop - 1])) stop--;
    if (stop <= stmtStart) return;
    const text = sql.slice(stmtStart, stop);
    const verbMatch = /^[A-Za-z][A-Za-z0-9_$#]*/.exec(text);
    out.push({
      text,
      start: stmtStart,
      end: stop,
      verb: verbMatch ? verbMatch[0].toUpperCase() : '',
      block: seed.block,
    });
  };

  while (i < n) {
    const c = sql[i];

    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      i = skipTrivia(sql, i, rules);
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i = skipTrivia(sql, i, rules);
      continue;
    }

    // A lone `/` ends whatever is open, whatever the depth counter currently believes. `/` is
    // SQL*Plus's unambiguous terminator and the counter is a heuristic; when they disagree the
    // unambiguous one is right. Because real scripts end their blocks with `/`, this one rule
    // neutralises most of the counter's failure modes. Checked before stmtStart is assigned, so
    // a stray `/` between statements is skipped rather than starting one.
    if (rules.slashTerminator && c === '/' && aloneOnLine(sql, i, 1)) {
      if (stmtStart !== -1) {
        emit(i);
        reset();
      }
      i++;
      continue;
    }

    if (
      rules.goSeparator &&
      (c === 'G' || c === 'g') &&
      (sql[i + 1] === 'O' || sql[i + 1] === 'o') &&
      !isWordChar(sql[i + 2]) &&
      aloneOnLine(sql, i, 2)
    ) {
      if (stmtStart !== -1) {
        emit(i);
        reset();
      }
      i += 2;
      continue;
    }

    if (stmtStart === -1) {
      stmtStart = i;
      seed = detectBlock(sql, i, rules);
      depth = seed.depth;
      pendingBody = seed.pendingBody;
    }

    if (c === ';') {
      if (seed.block && (depth > 0 || pendingBody)) {
        i++;
        continue;
      }
      // A plain statement drops its `;` (oracledb raises ORA-00911 on a trailing one); a PL/SQL
      // block keeps it (it is part of the block's syntax). Deciding it here is what lets the
      // driver send `text` untouched — "is this a block" is knowledge this module has and the
      // driver does not.
      emit(seed.block ? i + 1 : i);
      reset();
      i++;
      continue;
    }

    if (c === "'") {
      i = scanSingleQuoted(sql, i);
      continue;
    }

    if (
      rules.alternativeQuoting &&
      (c === 'q' || c === 'Q') &&
      sql[i + 1] === "'" &&
      !isWordChar(sql[i - 1])
    ) {
      const delim = sql[i + 2];
      // Whitespace and `'` are not legal delimiters. A malformed literal should cost one
      // statement, not the rest of the file, so fall back to reading it as an ordinary string.
      if (delim === undefined || isSpace(delim) || delim === "'") {
        i = scanSingleQuoted(sql, i + 1);
        continue;
      }
      const terminator = altQuoteClose(delim) + "'";
      // No escaping exists inside a q-quote: q'{a}b}' closes at `a}`, exactly as Oracle does.
      const close = sql.indexOf(terminator, i + 3);
      i = close === -1 ? n : close + 2;
      continue;
    }

    if (rules.dollarQuoting && c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close !== -1) {
          i = close + tag[0].length;
          continue;
        }
      }
      // No closing tag anywhere ahead: this is a $1 placeholder or an a$b identifier, not a
      // quote. Treating it as one would swallow the rest of the script.
      i++;
      continue;
    }

    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (rules.bracketIdentifiers && c === '[') {
      i++;
      while (i < n) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (isWordChar(c)) {
      const wordStart = i;
      while (i < n && isWordChar(sql[i])) i++;
      // Depth is tracked only inside a detected block. Outside one it would buy nothing — a
      // plain statement still ends at its `;` — while adding a way to go wrong.
      if (seed.block) {
        const word = sql.slice(wordStart, i).toUpperCase();
        if (DEPTH_OPENERS.has(word)) {
          // END IF / END LOOP / END CASE are consumed as one unit below, so an opener reached
          // here is always a real one.
          depth++;
          pendingBody = false;
        } else if (word === 'END') {
          if (depth > 0) depth--;
          // Step over `END IF`, `END LOOP`, `END CASE`, and `END <label>` together. Without
          // this the LOOP in `END LOOP` immediately reopens what the END just closed.
          const after = skipTrivia(sql, i, rules);
          if (isWordChar(sql[after])) {
            let j = after;
            while (j < n && isWordChar(sql[j])) j++;
            i = j;
          }
        }
      }
      continue;
    }

    i++;
  }

  // Whatever is left is an unterminated statement — which is what someone mid-typing has, and
  // F9 should still be able to run it.
  if (stmtStart !== -1) emit(n);
  return out;
}

/** Consumes a '...' literal starting at the opening quote; '' escapes. Runs to EOF if unclosed. */
function scanSingleQuoted(sql: string, i: number): number {
  i++;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * Picks the statement a caret at `offset` is in.
 *
 * A caret in the gap between two statements, or inside a leading comment, resolves to the
 * statement BELOW it. That is the safe direction: the worst case is running the next statement
 * rather than silently re-running the previous one, which the user has probably just run.
 */
export function statementAtOffset(
  statements: SqlStatement[],
  offset: number,
): SqlStatement | undefined {
  if (statements.length === 0) return undefined;
  for (const s of statements) {
    // `end` inclusive, so a caret parked immediately after the final character still counts.
    if (offset >= s.start && offset <= s.end) return s;
  }
  return statements.find((s) => s.start >= offset) ?? statements[statements.length - 1];
}
