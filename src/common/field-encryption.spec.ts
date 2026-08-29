import { randomBytes } from 'crypto';
import {
  constantTimeEquals,
  decryptField,
  encryptField,
  FieldEncryptionKeyError,
  loadEncryptionKey,
  resetEncryptionKeyCache,
} from './field-encryption';

const KEY = randomBytes(32).toString('base64');
const NATIONAL_ID = '29801011234567';

beforeEach(() => {
  resetEncryptionKeyCache();
  process.env.FIELD_ENCRYPTION_KEY = KEY;
});

describe('encryptField / decryptField', () => {
  it('round-trips a national ID', () => {
    expect(decryptField(encryptField(NATIONAL_ID))).toBe(NATIONAL_ID);
  });

  it('round-trips Arabic text and multi-byte characters', () => {
    expect(decryptField(encryptField('أحمد ٢٠٢٦'))).toBe('أحمد ٢٠٢٦');
  });

  // A deterministic ciphertext would let anyone with database access see that
  // two students share a national ID, or match a row against a guess.
  it('produces a different ciphertext each time for the same input', () => {
    const first = encryptField(NATIONAL_ID);
    const second = encryptField(NATIONAL_ID);

    expect(first.equals(second)).toBe(false);
    expect(decryptField(first)).toBe(decryptField(second));
  });

  it('never contains the plaintext in the stored bytes', () => {
    expect(encryptField(NATIONAL_ID).toString('utf8')).not.toContain(
      NATIONAL_ID,
    );
  });

  // The reason for GCM over CBC: tampering must fail loudly rather than
  // decrypt to plausible garbage.
  it('refuses a ciphertext whose bytes were altered', () => {
    const stored = encryptField(NATIONAL_ID);
    stored[stored.length - 1] ^= 0xff;

    expect(() => decryptField(stored)).toThrow();
  });

  it('refuses a ciphertext whose auth tag was altered', () => {
    const stored = encryptField(NATIONAL_ID);
    stored[12] ^= 0xff; // first byte of the tag

    expect(() => decryptField(stored)).toThrow();
  });

  it('refuses a value encrypted under a different key', () => {
    const stored = encryptField(NATIONAL_ID);
    resetEncryptionKeyCache();
    process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');

    expect(() => decryptField(stored)).toThrow();
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['shorter than the IV', Buffer.alloc(8)],
    ['IV and tag but no ciphertext body', Buffer.alloc(20)],
  ])('refuses a stored value that is %s', (_label, stored) => {
    expect(() => decryptField(stored)).toThrow();
  });

  it('handles an empty string as a distinct value from no value at all', () => {
    expect(decryptField(encryptField(''))).toBe('');
  });
});

describe('loadEncryptionKey', () => {
  it.each([
    ['hex', randomBytes(32).toString('hex')],
    ['base64', randomBytes(32).toString('base64')],
  ])('accepts a 32-byte key in %s', (_label, key) => {
    process.env.FIELD_ENCRYPTION_KEY = key;
    resetEncryptionKeyCache();

    expect(loadEncryptionKey()).toHaveLength(32);
  });

  // Generating a fallback key would encrypt today's rows unreadably tomorrow,
  // and the damage would only surface months later.
  it('throws rather than inventing a key when the variable is missing', () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    resetEncryptionKeyCache();

    expect(() => loadEncryptionKey()).toThrow(FieldEncryptionKeyError);
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(64).toString('base64')],
  ])('rejects a key that is %s', (_label, key) => {
    process.env.FIELD_ENCRYPTION_KEY = key;
    resetEncryptionKeyCache();

    expect(() => loadEncryptionKey()).toThrow(FieldEncryptionKeyError);
  });
});

describe('constantTimeEquals', () => {
  it.each([
    ['identical strings', NATIONAL_ID, NATIONAL_ID, true],
    ['differing strings of equal length', NATIONAL_ID, '29801011234568', false],
    ['strings of different lengths', NATIONAL_ID, '298', false],
    ['two empty strings', '', '', true],
  ])('%s → %s', (_label, a, b, expected) => {
    expect(constantTimeEquals(a, b)).toBe(expected);
  });
});
