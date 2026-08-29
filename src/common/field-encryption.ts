import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

/**
 * Authenticated encryption for the one column that holds government identity
 * data: `students.national_id_enc` (spec §9, "encrypt national_id at rest").
 *
 * AES-256-GCM rather than AES-CBC: GCM authenticates the ciphertext, so a row
 * tampered with directly in the database fails to decrypt instead of returning
 * plausible-looking garbage. Postgres `pgcrypto` was the alternative; keeping
 * the key in the application means a leaked database dump — the actual threat
 * — does not also leak the key needed to read it.
 *
 * Stored layout, one BYTEA value:
 *
 *     [ 12-byte IV ][ 16-byte auth tag ][ ciphertext ]
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified and fastest for
const TAG_BYTES = 16;

export class FieldEncryptionKeyError extends Error {}

let cachedKey: Buffer | null = null;

/**
 * Reads `FIELD_ENCRYPTION_KEY` (base64 or hex, 32 bytes decoded).
 *
 * Throws rather than falling back to a generated key: a per-process random key
 * would encrypt today's rows unreadably tomorrow, and the failure would only
 * surface months later when someone tried to read a national ID back.
 */
export function loadEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new FieldEncryptionKeyError(
      'FIELD_ENCRYPTION_KEY is not set; national IDs cannot be stored',
    );
  }
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new FieldEncryptionKeyError(
      `FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  cachedKey = decoded;
  return decoded;
}

export function encryptField(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptField(stored: Buffer): string {
  if (stored.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted value is truncated');
  }
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = stored.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, loadEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  // `final()` throws when the tag does not verify — that throw is the whole
  // point of GCM and must not be caught and turned into a null result.
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Equality without leaking position through timing. Used for "is this the same
 * national ID" checks, which must not become an oracle for guessing one digit
 * at a time.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

// Test-only: the module-level cache would otherwise pin the first key seen for
// the life of the process.
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}
