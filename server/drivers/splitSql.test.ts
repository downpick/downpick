import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSql, statementAtOffset, SqlDialect } from './splitSql';

/** Texts only — the range invariant is asserted separately by `check` below. */
function texts(sql: string, dialect: SqlDialect = 'oracle'): string[] {
  return splitSql(sql, dialect).map((s) => s.text);
}

/**
 * Splits and asserts the one invariant every offset in the app depends on:
 * text === sql.slice(start, end). If that ever drifts, error line numbers and F9 both point at
 * the wrong place, and neither failure looks like a splitter bug from the outside.
 */
function check(sql: string, dialect: SqlDialect = 'oracle') {
  const statements = splitSql(sql, dialect);
  for (const s of statements) {
    assert.equal(s.text, sql.slice(s.start, s.end), `range/text mismatch for ${s.text}`);
    assert.ok(s.text.length > 0, 'emitted an empty statement');
  }
  return statements;
}

test('splits plain statements and drops their terminating semicolon', () => {
  // The `;` must go: oracledb raises ORA-00911 on a trailing one.
  assert.deepEqual(texts('SELECT 1 FROM dual; SELECT 2 FROM dual;'), [
    'SELECT 1 FROM dual',
    'SELECT 2 FROM dual',
  ]);
});

test('a final statement without a terminator is still emitted', () => {
  // What someone mid-typing has. F9 has to keep working on it.
  assert.deepEqual(texts('SELECT 1 FROM dual'), ['SELECT 1 FROM dual']);
  assert.deepEqual(texts('SELECT 1 FROM dual;\nSELECT 2 FROM dual'), [
    'SELECT 1 FROM dual',
    'SELECT 2 FROM dual',
  ]);
});

test('leading comments and blank runs fall outside the statement', () => {
  const stmts = check('-- explain\n\n  SELECT 1 FROM dual;\n\n/* trailing */\n');
  assert.deepEqual(stmts.map((s) => s.text), ['SELECT 1 FROM dual']);
  assert.equal(stmts[0].verb, 'SELECT');
});

test('semicolons inside strings, identifiers and comments do not split', () => {
  assert.deepEqual(texts(`SELECT 'a;b' FROM dual`), [`SELECT 'a;b' FROM dual`]);
  assert.deepEqual(texts(`SELECT 'it''s; fine' FROM dual`), [`SELECT 'it''s; fine' FROM dual`]);
  assert.deepEqual(texts(`SELECT "we;ird" FROM t`), [`SELECT "we;ird" FROM t`]);
  assert.deepEqual(texts('SELECT 1 -- a; b\nFROM dual'), ['SELECT 1 -- a; b\nFROM dual']);
  assert.deepEqual(texts('SELECT /* a; b */ 1 FROM dual'), ['SELECT /* a; b */ 1 FROM dual']);
});

test('Oracle alternative quoting hides quotes and semicolons', () => {
  // The entire point of q-quoting: an unescaped ' inside the literal.
  assert.deepEqual(texts(`SELECT q'[it's; fine]' FROM dual`), [`SELECT q'[it's; fine]' FROM dual`]);
  assert.deepEqual(texts(`SELECT Q'!a;b!' FROM dual`), [`SELECT Q'!a;b!' FROM dual`]);
  assert.deepEqual(texts(`SELECT q'{a;b}' FROM dual`), [`SELECT q'{a;b}' FROM dual`]);
  assert.deepEqual(texts(`SELECT q'(a;b)' FROM dual`), [`SELECT q'(a;b)' FROM dual`]);
});

test('a q-quote closes at the first delimiter pair, with no escaping', () => {
  // q'{a}b}' closes at `a}`, leaving `b}'` as SQL — exactly what Oracle does. It looks like a
  // bug from the outside, which is why it is pinned here.
  assert.deepEqual(texts(`SELECT q'{a}b}' FROM dual`), [`SELECT q'{a}b}' FROM dual`]);
});

test('a q that is part of an identifier is not an alternative quote', () => {
  assert.deepEqual(texts(`SELECT seq'x' FROM dual`), [`SELECT seq'x' FROM dual`]);
});

test('recognises a bare PL/SQL block and keeps its inner semicolons', () => {
  const sql = 'BEGIN NULL; NULL; END;';
  const stmts = check(sql);
  assert.equal(stmts.length, 1);
  // The trailing `;` is KEPT — a block without it is a syntax error, unlike a plain statement.
  assert.equal(stmts[0].text, 'BEGIN NULL; NULL; END;');
  assert.equal(stmts[0].block, true);
});

test('a DECLARE section before BEGIN does not split', () => {
  const stmts = check('DECLARE n NUMBER; BEGIN NULL; END;');
  assert.deepEqual(stmts.map((s) => s.text), ['DECLARE n NUMBER; BEGIN NULL; END;']);
});

test('a procedure declare section does not split before its BEGIN', () => {
  // The `;` after `n NUMBER` sits at depth 0; pendingBody is what suppresses it.
  const stmts = check('CREATE PROCEDURE p IS n NUMBER; BEGIN NULL; END;');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].block, true);
});

test('END LOOP and END IF do not reopen the block they just closed', () => {
  const sql = 'BEGIN FOR r IN (SELECT 1 FROM dual) LOOP IF 1=1 THEN NULL; END IF; END LOOP; END;';
  const stmts = check(sql);
  assert.equal(stmts.length, 1, 'depth tracking unbalanced');
  assert.equal(stmts[0].text, sql);
});

test('a package body with nested routines balances to one statement', () => {
  const sql = [
    'CREATE OR REPLACE PACKAGE BODY p AS',
    '  PROCEDURE go IS BEGIN NULL; END go;',
    '  FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END f;',
    'END p;',
  ].join('\n');
  const stmts = check(sql);
  assert.equal(stmts.length, 1, 'nested PROCEDURE/FUNCTION must not count as depth openers');
  assert.equal(stmts[0].block, true);
});

test('a lone slash terminates a block and is excluded from the text', () => {
  const stmts = check('BEGIN NULL; END;\n/\nSELECT 1 FROM dual;');
  assert.deepEqual(stmts.map((s) => s.text), ['BEGIN NULL; END;', 'SELECT 1 FROM dual']);
});

test('a lone slash overrides an unbalanced depth counter', () => {
  // The backstop for every case the block heuristic gets wrong. `END IF` is missing here, so the
  // counter never returns to 0 — the `/` closes it anyway.
  const stmts = check('BEGIN IF 1=1 THEN NULL;\n/\nSELECT 1 FROM dual;');
  assert.equal(stmts.length, 2);
  assert.equal(stmts[1].text, 'SELECT 1 FROM dual');
});

test('a slash that is division is not a terminator', () => {
  assert.deepEqual(texts('SELECT a\n/ b FROM t;'), ['SELECT a\n/ b FROM t']);
  assert.deepEqual(texts('SELECT a /\nb FROM t;'), ['SELECT a /\nb FROM t']);
});

test('ALTER never opens a block, and CREATE VIEW / bare CREATE TYPE are not blocks', () => {
  // Each of these sits exactly where a block keyword would, which is why they are pinned.
  assert.equal(splitSql('ALTER PROCEDURE p COMPILE;', 'oracle')[0].block, false);
  assert.equal(splitSql('CREATE OR REPLACE FORCE VIEW v AS SELECT 1 FROM dual;', 'oracle')[0].block, false);
  assert.equal(splitSql('CREATE TYPE addr AS OBJECT (street VARCHAR2(30));', 'oracle')[0].block, false);
  assert.equal(splitSql('CREATE TYPE BODY b AS END;', 'oracle')[0].block, true);
});

test('reports the leading keyword as verb', () => {
  const stmts = splitSql('UPDATE t SET a = 1; SELECT 1 FROM dual;', 'oracle');
  assert.deepEqual(stmts.map((s) => s.verb), ['UPDATE', 'SELECT']);
});

test('postgres dollar quoting hides the semicolons in a function body', () => {
  const sql = [
    'CREATE FUNCTION f() RETURNS int AS $$',
    'BEGIN',
    '  RETURN 1;',
    'END;',
    '$$ LANGUAGE plpgsql;',
    'SELECT 1;',
  ].join('\n');
  const stmts = check(sql, 'postgres');
  assert.equal(stmts.length, 2, 'the $$ body must not split');
  assert.equal(stmts[1].text, 'SELECT 1');
});

test('postgres tagged dollar quoting round-trips', () => {
  const stmts = check('SELECT $tag$a;b$tag$; SELECT 2;', 'postgres');
  assert.deepEqual(stmts.map((s) => s.text), ['SELECT $tag$a;b$tag$', 'SELECT 2']);
});

test('an unmatched dollar is a placeholder, not a quote', () => {
  // Without the "is there a closing tag" check, $1 would swallow the rest of the script.
  const stmts = check('SELECT * FROM t WHERE id = $1; SELECT 2;', 'postgres');
  assert.equal(stmts.length, 2);
});

test('postgres nests block comments; oracle does not', () => {
  assert.deepEqual(texts('SELECT /* a /* b */ c */ 1;', 'postgres'), ['SELECT /* a /* b */ c */ 1']);
  // Oracle closes at the first */, leaving `c */` as part of the statement.
  assert.deepEqual(texts('SELECT /* a /* b */ c */ 1 FROM dual;'), ['SELECT /* a /* b */ c */ 1 FROM dual']);
});

test('sqlserver treats a lone GO as a batch separator and brackets as identifiers', () => {
  const stmts = check('SELECT 1\nGO\nSELECT 2\n', 'sqlserver');
  assert.deepEqual(stmts.map((s) => s.text), ['SELECT 1', 'SELECT 2']);
  assert.deepEqual(texts('SELECT [we;ird] FROM t;', 'sqlserver'), ['SELECT [we;ird] FROM t']);
});

test('GO inside a word is not a separator', () => {
  assert.deepEqual(texts('SELECT 1\nGOTO x\n', 'sqlserver'), ['SELECT 1\nGOTO x']);
});

test('unterminated quotes do not throw or lose the statement', () => {
  assert.doesNotThrow(() => splitSql(`SELECT 'abc`, 'oracle'));
  assert.doesNotThrow(() => splitSql(`SELECT q'[abc`, 'oracle'));
  assert.doesNotThrow(() => splitSql('SELECT "abc', 'oracle'));
  assert.equal(splitSql(`SELECT 'abc`, 'oracle').length, 1);
});

test('statementAtOffset resolves a caret inside, at the edge, and in the gap', () => {
  const sql = 'SELECT 1 FROM dual;\nSELECT 2 FROM dual;\nSELECT 3 FROM dual;';
  const stmts = splitSql(sql, 'oracle');
  const at = (offset: number) => statementAtOffset(stmts, offset)?.text;

  assert.equal(at(sql.indexOf('2')), 'SELECT 2 FROM dual');
  // Caret parked immediately after the last character of a statement stays on it.
  assert.equal(at(stmts[0].end), 'SELECT 1 FROM dual');
  // In the gap between statements, resolve DOWN — running the next one beats silently
  // re-running the one just executed.
  assert.equal(at(sql.indexOf('\nSELECT 2') + 1), 'SELECT 2 FROM dual');
  assert.equal(at(sql.length), 'SELECT 3 FROM dual');
  assert.equal(at(0), 'SELECT 1 FROM dual');
});

test('statementAtOffset on an empty script returns undefined rather than throwing', () => {
  assert.equal(statementAtOffset(splitSql('   \n-- nothing\n', 'oracle'), 0), undefined);
});
