import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptFailure, toDisplayValue } from './oracle';
import { errorLine } from '../handlers/query';
import { splitSql } from './splitSql';

/** Shapes an oracledb failure the way node-oracledb reports one: errorNum plus a 0-based offset. */
function oraError(message: string, offset?: number) {
  return Object.assign(new Error(message), { errorNum: 904, offset });
}

test('a failure mid-script says which statement stopped it and what already ran', () => {
  const parts = splitSql('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); SELCT 1 FROM dual', 'oracle');
  const err = scriptFailure(oraError('ORA-00900: invalid SQL statement'), parts[2], parts.length, [
    { command: 'INSERT', rowsAffected: 1 },
    { command: 'INSERT', rowsAffected: 1 },
  ]);

  assert.match(err.message, /Statement 3 of 3 failed/);
  assert.match(err.message, /ORA-00900/);
  // Autocommit means those two rows are already committed. Saying so is the point of the
  // sentence — "stop at the first failure" is only honest if the user is told what landed.
  assert.match(err.message, /first 2 statements ran and changed 2 row\(s\)/);
  assert.match(err.message, /nothing after this one was attempted/);
});

test('a single-statement failure is reported without the statement-counting preamble', () => {
  const parts = splitSql('SELCT 1 FROM dual', 'oracle');
  const err = scriptFailure(oraError('ORA-00900: invalid SQL statement'), parts[0], 1, []);
  assert.equal(err.message, 'ORA-00900: invalid SQL statement');
  assert.doesNotMatch(err.message, /Statement 1 of 1/);
});

test('an error offset maps back to the right line of the whole script', () => {
  // The arithmetic this pins down is the reason splitSql returns ranges: oracledb measures its
  // offset against the ONE statement it was handed, so without part.start every error in a
  // script would point at a line near the top of the file.
  const script = [
    'SELECT 1 FROM dual;', // line 1
    '', // line 2
    'SELECT 2 FROM dual;', // line 3
    '', // line 4
    'SELECT bad_column FROM dual', // line 5 — the failing one
  ].join('\n');
  const parts = splitSql(script, 'oracle');
  assert.equal(parts.length, 3);

  // Offset 7 lands on `bad_column` within statement 3, counting from that statement's own start.
  const err = scriptFailure(oraError('ORA-00904: invalid identifier', 7), parts[2], 3, []);
  assert.equal(errorLine(script, err), 5);
});

test('an error with no usable offset pins to the failing statement, not to line 1', () => {
  // ORA-00942 is located by the server rather than the parser and reports offset 0. Falling back
  // to line 1 of a forty-statement script would be actively misleading.
  const script = ['SELECT 1 FROM dual;', '', '', 'SELECT * FROM missing_table'].join('\n');
  const parts = splitSql(script, 'oracle');
  const err = scriptFailure(oraError('ORA-00942: table or view does not exist', 0), parts[1], 2, []);
  assert.equal(errorLine(script, err), 4);
});

test('statements that ran but reported no count say "completed" rather than "changed 0 rows"', () => {
  const parts = splitSql('CREATE TABLE t (a NUMBER); SELCT 1', 'oracle');
  const err = scriptFailure(oraError('ORA-00900'), parts[1], 2, [{ command: 'CREATE' }]);
  assert.match(err.message, /ran and completed/);
  assert.doesNotMatch(err.message, /changed 0 row/);
});

test('dates become ISO strings, which is what the xlsx export sniffs for', () => {
  const value = toDisplayValue(new Date(Date.UTC(2026, 0, 15, 10, 30)));
  assert.equal(value, '2026-01-15T10:30:00.000Z');
  assert.match(String(value), /^\d{4}-\d{2}-\d{2}T/);
});

test('short RAW renders as hex; a large BLOB renders as a size placeholder', () => {
  // A RAW(16) GUID is worth showing and pasting back into a query.
  assert.equal(toDisplayValue(Buffer.from([0xde, 0xad, 0xbe, 0xef])), 'DEADBEEF');
  // A real BLOB is not: its bytes would be JSON-encoded one array element per byte over IPC.
  const blob = Buffer.alloc(5000);
  assert.equal(toDisplayValue(blob), '<5000 bytes>');
});

test('ordinary values pass through untouched', () => {
  assert.equal(toDisplayValue('VARCHAR2 text'), 'VARCHAR2 text');
  assert.equal(toDisplayValue(42), 42);
  assert.equal(toDisplayValue(null), null);
});
