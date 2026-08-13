import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault,
  openVault,
  parseHeader,
  rewrapVault,
  serializeVault,
  verifyPassword,
  VaultCorruptError,
  VaultFormatError,
  WrongPasswordError,
  VAULT_VERSION,
} from './crypto';

const PASSWORD = 'correct horse battery staple';
const SECRET = Buffer.from(JSON.stringify({ connections: [{ password: 'hunter2' }] }), 'utf-8');

function reencodeHeader(serialized: string, mutate: (h: Record<string, any>) => void): string {
  const envelope = JSON.parse(serialized);
  const header = JSON.parse(Buffer.from(envelope.header, 'base64').toString('utf-8'));
  mutate(header);
  envelope.header = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64');
  return JSON.stringify(envelope);
}

function flipByte(serialized: string, field: string): string {
  const envelope = JSON.parse(serialized);
  const buf = Buffer.from(envelope[field], 'base64');
  buf[0] ^= 0xff;
  envelope[field] = buf.toString('base64');
  return JSON.stringify(envelope);
}

test('round-trips a payload through the correct password', async () => {
  const { serialized } = await createVault(PASSWORD, SECRET);
  const { plaintext } = await openVault(serialized, PASSWORD);
  assert.deepEqual(plaintext, SECRET);
});

test('rejects the wrong password with a typed error, never a crash', async () => {
  const { serialized } = await createVault(PASSWORD, SECRET);
  await assert.rejects(() => openVault(serialized, 'wrong password'), WrongPasswordError);
  // An empty password is a distinct code path worth pinning: it must fail, not open.
  await assert.rejects(() => openVault(serialized, ''), WrongPasswordError);
});

test('detects tampering in every ciphertext field', async () => {
  const { serialized } = await createVault(PASSWORD, SECRET);
  for (const field of ['wrappedDek', 'wrappedDekTag', 'payloadIv', 'payload']) {
    await assert.rejects(
      () => openVault(flipByte(serialized, field), PASSWORD),
      VaultCorruptError,
      `flipping a byte of "${field}" should be reported as corruption`,
    );
  }
  // A tampered checksum is itself a mismatch, so it is caught by the same check.
  await assert.rejects(() => openVault(flipByte(serialized, 'checksum'), PASSWORD), VaultCorruptError);
});

test('detects tampering in the authenticated header', async () => {
  const { serialized } = await createVault(PASSWORD, SECRET);
  // A swapped salt still parses, so it survives validation and fails at the GCM tag —
  // reported as a wrong password because the derived KEK genuinely no longer matches.
  const swappedSalt = reencodeHeader(serialized, (h) => {
    h.kdf.salt = Buffer.alloc(16, 7).toString('base64');
  });
  await assert.rejects(() => openVault(swappedSalt, PASSWORD), WrongPasswordError);

  const badVersion = reencodeHeader(serialized, (h) => {
    h.version = VAULT_VERSION + 1;
  });
  await assert.rejects(() => openVault(badVersion, PASSWORD), VaultFormatError);
});

test('rejects out-of-policy KDF parameters without ever deriving a key', async () => {
  const { serialized } = await createVault(PASSWORD, SECRET);

  const hostile: Array<[string, (h: Record<string, any>) => void]> = [
    ['N far above policy', (h) => { h.kdf.N = 1 << 24; }],
    ['N not a power of two', (h) => { h.kdf.N = 65535; }],
    ['N below policy', (h) => { h.kdf.N = 1024; }],
    ['r out of policy', (h) => { h.kdf.r = 99; }],
    ['p out of policy', (h) => { h.kdf.p = 64; }],
    ['oversized keylen', (h) => { h.kdf.keylen = 1 << 20; }],
    ['short salt', (h) => { h.kdf.salt = Buffer.alloc(4).toString('base64'); }],
    ['unknown kdf', (h) => { h.kdf.algo = 'pbkdf2'; }],
  ];

  for (const [label, mutate] of hostile) {
    const tampered = reencodeHeader(serialized, mutate);
    const started = process.hrtime.bigint();
    await assert.rejects(() => openVault(tampered, PASSWORD), VaultFormatError, label);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // A real derivation at the smallest allowed N takes hundreds of milliseconds; at
    // N=2^24 it would take minutes. Staying under 100ms proves validation ran first.
    assert.ok(elapsedMs < 100, `${label}: rejection took ${elapsedMs.toFixed(1)}ms — the KDF ran`);
  }
});

test('uses a fresh IV on every write and a fresh salt on every wrap', async () => {
  const { keys, serialized } = await createVault(PASSWORD, SECRET);

  const ivs = new Set<string>();
  for (let i = 0; i < 5; i++) {
    ivs.add(JSON.parse(serializeVault(keys, SECRET)).payloadIv);
  }
  assert.equal(ivs.size, 5, 'each write must use a fresh payload IV');

  // Re-wrapping to the *same* password must still produce a fresh salt and wrap IV:
  // reusing them would be a same-key/same-nonce GCM reuse across two DEK wraps.
  const first = parseHeader(JSON.parse(serialized).header);
  const { keys: again } = await rewrapVault(keys, PASSWORD, SECRET);
  const second = parseHeader(again.headerB64);
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.wrapIv, second.wrapIv);
});

test('changing the password keeps the DEK and the data', async () => {
  const { keys, serialized } = await createVault(PASSWORD, SECRET);
  const original = await openVault(serialized, PASSWORD);

  const { serialized: rotated } = await rewrapVault(keys, 'a brand new master password', SECRET);
  const reopened = await openVault(rotated, 'a brand new master password');

  assert.deepEqual(reopened.plaintext, SECRET);
  assert.deepEqual(reopened.keys.dek, original.keys.dek, 'the DEK must survive a password change');
  await assert.rejects(() => openVault(rotated, PASSWORD), WrongPasswordError);
});

test('verifyPassword accepts the current password and nothing else', async () => {
  const { keys } = await createVault(PASSWORD, SECRET);
  assert.equal(await verifyPassword(keys, PASSWORD), true);
  assert.equal(await verifyPassword(keys, 'nope'), false);
});

test('reports a damaged file as damaged rather than as a wrong password', async () => {
  const { serialized } = await createVault(PASSWORD, SECRET);
  await assert.rejects(() => openVault(serialized.slice(0, serialized.length / 2), PASSWORD), VaultCorruptError);
  await assert.rejects(() => openVault('not json at all', PASSWORD), VaultCorruptError);
  await assert.rejects(() => openVault('{}', PASSWORD), VaultFormatError);
});
