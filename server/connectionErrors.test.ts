import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectionError } from './connectionErrors';

const ORACLE = { type: 'oracle' as const, host: 'db.internal', port: 1521, username: 'app' };

/** node-oracledb shapes an ORA- failure as a plain Error carrying `errorNum`, not `code`. */
function ora(errorNum: number, message: string) {
  return Object.assign(new Error(message), { errorNum });
}

test('a refused socket is recognised even when the errno is only in the message text', () => {
  // node-oracledb reports `code: 'NJS-503'` with NO nested cause and the errno buried in its
  // message. A code-only test misses the most common failure there is and falls through to a raw
  // driver dump, which is what this regression pins.
  const err = Object.assign(
    new Error(
      'NJS-503: connection to host db.internal port 1521 could not be established.\n' +
        'connect ECONNREFUSED 10.0.0.5:1521',
    ),
    { code: 'NJS-503' },
  );
  const message = describeConnectionError(err, ORACLE);
  assert.match(message, /connection was refused/);
  assert.match(message, /Oracle is running and listening on port 1521/);
});

test('an unrecognised NJS transport failure still gets a useful message', () => {
  const err = Object.assign(new Error('NJS-510: connection could not be established'), {
    code: 'NJS-510',
  });
  const message = describeConnectionError(err, ORACLE);
  assert.match(message, /Could not open a connection to db\.internal:1521/);
  assert.match(message, /listener is running/);
});

test('ORA-01017 reads as an authentication failure naming the user', () => {
  const message = describeConnectionError(
    ora(1017, 'ORA-01017: invalid username/password; logon denied'),
    ORACLE,
  );
  assert.match(message, /Authentication failed for user "app"/);
});

test('ORA-12514 names the service and points back at the Service Name field', () => {
  // The most common Oracle-specific mistake, and the reason that field exists at all.
  const message = describeConnectionError(
    ora(12514, 'ORA-12514: listener does not currently know of service requested'),
    { ...ORACLE, serviceName: 'FREEPDB1' },
  );
  assert.match(message, /does not serve "FREEPDB1"/);
  assert.match(message, /Service Name/);
  assert.match(message, /not the SID/);
});

test('Thin mode reports a wrong service as NJS-518, not ORA-12514', () => {
  // Verified against a live Oracle: node-oracledb resolves the service itself in Thin mode and
  // never produces ORA-12514, which is what the Oracle *client* returns. Testing only the ORA
  // spelling meant the single most useful Oracle message never fired for real connections.
  const err = Object.assign(
    new Error(
      'NJS-518: cannot connect to Oracle Database. Service "NOPE" is not registered with the listener at host 127.0.0.1 port 1521.',
    ),
    { code: 'NJS-518' },
  );
  const message = describeConnectionError(err, { ...ORACLE, serviceName: 'NOPE' });
  assert.match(message, /does not serve "NOPE"/);
  assert.match(message, /Service Name/);
});

test('ORA-12541 distinguishes a missing listener from a refused socket', () => {
  const message = describeConnectionError(ora(12541, 'ORA-12541: TNS:no listener'), ORACLE);
  assert.match(message, /No Oracle listener is answering/);
});

test('ORA-28000 and ORA-28001 explain what a DBA has to do', () => {
  assert.match(
    describeConnectionError(ora(28000, 'ORA-28000: the account is locked'), ORACLE),
    /locked.*ACCOUNT UNLOCK/s,
  );
  assert.match(
    describeConnectionError(ora(28001, 'ORA-28001: the password has expired'), ORACLE),
    /expired.*retyping the old one will not help/s,
  );
});

test('native network encryption is named as the Thin-mode limitation it is', () => {
  const err = new Error('Advanced Networking Option service negotiation failed. Native Network Encryption');
  assert.match(describeConnectionError(err, ORACLE), /Thin mode, which supports TLS/);
});

test('an unrecognised Oracle failure falls back to the raw text rather than inventing one', () => {
  const message = describeConnectionError(ora(1234, 'ORA-01234: something unusual'), ORACLE);
  assert.match(message, /ORA-01234: something unusual/);
});

test('the engine label is used for non-Oracle types too', () => {
  const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  assert.match(
    describeConnectionError(err, { type: 'postgres', host: 'h', port: 5432 }),
    /PostgreSQL is running/,
  );
});
