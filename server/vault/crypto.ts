import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'crypto';
import { promisify } from 'util';

/**
 * Envelope format for the encrypted vault. Pure functions only — no file I/O, no state,
 * no domain types. The store layer owns all of those.
 *
 *   master password --scrypt--> KEK
 *   KEK --AES-256-GCM--> wraps a random DEK
 *   DEK --AES-256-GCM--> encrypts the payload
 *
 * The DEK survives a password change, so changing the master password only re-wraps 32
 * bytes instead of re-encrypting everything.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const VAULT_VERSION = 1;

// N=2^17, r=8, p=1 is the OWASP first-choice scrypt profile. It costs ~130 MiB and ~0.3s
// per derivation here, which is paid once per unlock and is the only thing standing
// between a stolen vault file and an offline brute-force run.
export const KDF_N = 1 << 17;
export const KDF_R = 8;
export const KDF_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Node's default scrypt maxmem is 32 MiB, while the profile above needs 128*N*r = 128 MiB,
// so without an explicit maxmem every derivation fails with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
function maxmemFor(N: number, r: number): number {
  return 128 * N * r + (1 << 20);
}

// Policy bounds for a *stored* header. These are enforced before the KDF runs: the AAD is
// only checked after derivation, so a file claiming N=2^24 would hang or exhaust memory
// long before its authentication tag was ever examined. Validation must come first.
const MIN_N = 1 << 15;
const MAX_N = 1 << 18;

// A vault holding a few dozen connections and API keys is kilobytes. This bound exists so
// a hostile file cannot make us allocate gigabytes before any check runs.
const MAX_PAYLOAD_B64 = 8 * 1024 * 1024;

/** The password did not open the vault. The file itself is intact. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect master password.');
    this.name = 'WrongPasswordError';
  }
}

/** The file is damaged or was truncated — distinct from a wrong password, so the UI can
 * offer to restore the backup instead of sending the user off to guess passwords. */
export class VaultCorruptError extends Error {
  constructor(detail: string) {
    super(`The vault file is damaged: ${detail}`);
    this.name = 'VaultCorruptError';
  }
}

/** The file is not a vault this version understands. */
export class VaultFormatError extends Error {
  constructor(detail: string) {
    super(`Unrecognised vault file: ${detail}`);
    this.name = 'VaultFormatError';
  }
}

export interface KdfParams {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string;
}

/**
 * The authenticated header. Serialized once and carried as base64; those exact bytes are
 * the AAD for both GCM operations, so decryption never depends on V8 key ordering or on
 * this process re-serializing the object identically.
 *
 * It changes only when the DEK is wrapped (vault creation and password change) — never on
 * an ordinary write, which would otherwise invalidate the wrapped DEK's tag.
 */
export interface VaultHeader {
  version: number;
  kdf: KdfParams;
  wrapIv: string;
}

/** Everything needed to read and write an unlocked vault, minus the password. */
export interface VaultKeys {
  dek: Buffer;
  headerB64: string;
  wrappedDek: string;
  wrappedDekTag: string;
}

interface Envelope {
  header: string;
  wrappedDek: string;
  wrappedDekTag: string;
  payloadIv: string;
  payload: string;
  checksum: string;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function decodeExact(value: unknown, bytes: number, field: string): Buffer {
  // Cap the encoded length before decoding so an oversized field cannot be allocated.
  if (typeof value !== 'string' || value.length > 4 * bytes + 8) {
    throw new VaultFormatError(`field "${field}" is missing or oversized`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== bytes) {
    throw new VaultFormatError(`field "${field}" must decode to ${bytes} bytes`);
  }
  return buf;
}

/**
 * Parses and fully validates the header. Every value the KDF will consume is checked here,
 * before any derivation happens.
 */
export function parseHeader(headerB64: string): VaultHeader {
  if (typeof headerB64 !== 'string' || headerB64.length > 4096) {
    throw new VaultFormatError('header is missing or oversized');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf-8'));
  } catch {
    throw new VaultFormatError('header is not valid JSON');
  }
  const h = raw as Record<string, unknown>;
  if (h?.version !== VAULT_VERSION) {
    throw new VaultFormatError(
      `version ${String(h?.version)} is not supported (this build reads version ${VAULT_VERSION})`,
    );
  }
  const kdf = h.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.algo !== 'scrypt') {
    throw new VaultFormatError('unsupported key derivation function');
  }
  const { N, r, p, keylen } = kdf as { N: number; r: number; p: number; keylen: number };
  if (!isPowerOfTwo(N) || N < MIN_N || N > MAX_N) {
    throw new VaultFormatError(`scrypt N=${String(N)} is outside the accepted range`);
  }
  if (r !== KDF_R || p !== KDF_P || keylen !== KEY_LENGTH) {
    throw new VaultFormatError('scrypt parameters are outside the accepted range');
  }
  decodeExact(kdf.salt, SALT_LENGTH, 'kdf.salt');
  decodeExact(h.wrapIv, IV_LENGTH, 'wrapIv');

  return {
    version: VAULT_VERSION,
    kdf: { algo: 'scrypt', N, r, p, keylen, salt: kdf.salt as string },
    wrapIv: h.wrapIv as string,
  };
}

function parseEnvelope(raw: string): { envelope: Envelope; header: VaultHeader } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VaultCorruptError('the file is not valid JSON');
  }
  const e = parsed as Record<string, unknown>;
  const header = parseHeader(e.header as string);

  if (typeof e.payload !== 'string' || e.payload.length > MAX_PAYLOAD_B64) {
    throw new VaultFormatError('field "payload" is missing or oversized');
  }
  decodeExact(e.wrappedDek, KEY_LENGTH, 'wrappedDek');
  decodeExact(e.wrappedDekTag, TAG_LENGTH, 'wrappedDekTag');
  decodeExact(e.payloadIv, IV_LENGTH, 'payloadIv');
  decodeExact(e.checksum, 32, 'checksum');

  const envelope: Envelope = {
    header: e.header as string,
    wrappedDek: e.wrappedDek as string,
    wrappedDekTag: e.wrappedDekTag as string,
    payloadIv: e.payloadIv as string,
    payload: e.payload,
    checksum: e.checksum as string,
  };

  // The checksum covers every ciphertext field. It is unauthenticated on purpose — it is a
  // hash of ciphertext, so it reveals nothing — and its only job is to tell a damaged file
  // apart from a wrong password, which GCM alone cannot do. Verifying it here also means a
  // truncated file fails instantly instead of after a second of scrypt.
  if (!checksumOf(envelope).equals(Buffer.from(envelope.checksum, 'base64'))) {
    throw new VaultCorruptError('its contents do not match their checksum');
  }
  return { envelope, header };
}

function checksumOf(e: Pick<Envelope, 'wrappedDek' | 'wrappedDekTag' | 'payloadIv' | 'payload'>): Buffer {
  return createHash('sha256')
    .update(e.wrappedDek)
    .update(e.wrappedDekTag)
    .update(e.payloadIv)
    .update(e.payload)
    .digest();
}

async function deriveKek(password: string, header: VaultHeader): Promise<Buffer> {
  const { N, r, p, keylen, salt } = header.kdf;
  return scrypt(password, Buffer.from(salt, 'base64'), keylen, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });
}

/**
 * Builds a fresh header and wraps `dek` under a key derived from `password`.
 *
 * Salt and IV are generated unconditionally on every call. Reusing them across two wraps
 * under the same password — which is exactly what "changing" to the identical password
 * would do — is a same-key/same-nonce GCM reuse: it leaks the XOR of the two DEKs and
 * opens the door to forgery via authentication-key recovery.
 */
async function wrapDek(dek: Buffer, password: string): Promise<VaultKeys> {
  const salt = randomBytes(SALT_LENGTH);
  const wrapIv = randomBytes(IV_LENGTH);
  const header: VaultHeader = {
    version: VAULT_VERSION,
    kdf: {
      algo: 'scrypt',
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
      keylen: KEY_LENGTH,
      salt: salt.toString('base64'),
    },
    wrapIv: wrapIv.toString('base64'),
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64');

  const kek = await deriveKek(password, header);
  try {
    const cipher = createCipheriv('aes-256-gcm', kek, wrapIv);
    // Binding the header as AAD ties the wrapped DEK to its own KDF parameters and salt,
    // so a wrapped DEK cannot be spliced from another vault file.
    cipher.setAAD(Buffer.from(headerB64, 'utf-8'));
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      dek,
      headerB64,
      wrappedDek: wrapped.toString('base64'),
      wrappedDekTag: cipher.getAuthTag().toString('base64'),
    };
  } finally {
    kek.fill(0);
  }
}

/** Encrypts `plaintext` under the DEK, with a fresh IV, and serializes the whole envelope. */
export function serializeVault(keys: VaultKeys, plaintext: Buffer): string {
  const payloadIv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', keys.dek, payloadIv);
  cipher.setAAD(Buffer.from(keys.headerB64, 'utf-8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // The GCM tag is appended to the ciphertext rather than stored separately, so there is
  // one fewer field to validate and no way to pair a body with a foreign tag.
  const body = Buffer.concat([ciphertext, cipher.getAuthTag()]);

  const fields = {
    wrappedDek: keys.wrappedDek,
    wrappedDekTag: keys.wrappedDekTag,
    payloadIv: payloadIv.toString('base64'),
    payload: body.toString('base64'),
  };
  const envelope: Envelope = { header: keys.headerB64, ...fields, checksum: checksumOf(fields).toString('base64') };
  return JSON.stringify(envelope, null, 2);
}

/** Creates a brand-new vault: fresh DEK, fresh salt, payload sealed. */
export async function createVault(
  password: string,
  plaintext: Buffer,
): Promise<{ keys: VaultKeys; serialized: string }> {
  const keys = await wrapDek(randomBytes(KEY_LENGTH), password);
  return { keys, serialized: serializeVault(keys, plaintext) };
}

/** Opens a serialized vault. Throws WrongPasswordError, VaultCorruptError or VaultFormatError. */
export async function openVault(
  raw: string,
  password: string,
): Promise<{ keys: VaultKeys; plaintext: Buffer }> {
  const { envelope, header } = parseEnvelope(raw);
  const kek = await deriveKek(password, header);

  let dek: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(header.wrapIv, 'base64'));
    decipher.setAAD(Buffer.from(envelope.header, 'utf-8'));
    decipher.setAuthTag(Buffer.from(envelope.wrappedDekTag, 'base64'));
    dek = Buffer.concat([
      decipher.update(Buffer.from(envelope.wrappedDek, 'base64')),
      decipher.final(),
    ]);
  } catch {
    // The checksum already passed, so the ciphertext is the one that was written. The only
    // remaining explanation for a tag failure is the wrong key.
    throw new WrongPasswordError();
  } finally {
    kek.fill(0);
  }

  const body = Buffer.from(envelope.payload, 'base64');
  if (body.length < TAG_LENGTH) {
    throw new VaultCorruptError('the encrypted payload is too short');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.payloadIv, 'base64'));
    decipher.setAAD(Buffer.from(envelope.header, 'utf-8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_LENGTH)),
      decipher.final(),
    ]);
    return {
      keys: {
        dek,
        headerB64: envelope.header,
        wrappedDek: envelope.wrappedDek,
        wrappedDekTag: envelope.wrappedDekTag,
      },
      plaintext,
    };
  } catch {
    // The DEK unwrapped cleanly, so the password was right — the payload itself is broken.
    dek.fill(0);
    throw new VaultCorruptError('the encrypted payload failed its integrity check');
  }
}

/**
 * Re-wraps the existing DEK under a new password and re-seals the payload.
 *
 * The payload has to be re-sealed as well: the header is its AAD, and a new salt means a
 * new header. The DEK is unchanged, so any older copy of the file — a `.bak`, a backup —
 * remains readable under the *old* password. The store deletes those on password change.
 */
export async function rewrapVault(
  keys: VaultKeys,
  newPassword: string,
  plaintext: Buffer,
): Promise<{ keys: VaultKeys; serialized: string }> {
  const rewrapped = await wrapDek(keys.dek, newPassword);
  return { keys: rewrapped, serialized: serializeVault(rewrapped, plaintext) };
}

/** Verifies a password against an open vault without re-reading the file. */
export async function verifyPassword(keys: VaultKeys, password: string): Promise<boolean> {
  const header = parseHeader(keys.headerB64);
  const kek = await deriveKek(password, header);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(header.wrapIv, 'base64'));
    decipher.setAAD(Buffer.from(keys.headerB64, 'utf-8'));
    decipher.setAuthTag(Buffer.from(keys.wrappedDekTag, 'base64'));
    const dek = Buffer.concat([
      decipher.update(Buffer.from(keys.wrappedDek, 'base64')),
      decipher.final(),
    ]);
    const ok = timingSafeEqual(dek, keys.dek);
    dek.fill(0);
    return ok;
  } catch {
    return false;
  } finally {
    kek.fill(0);
  }
}
