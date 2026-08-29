import { LoginSchema } from './login.schema';

describe('LoginSchema', () => {
  it('accepts a valid username/password pair', () => {
    const result = LoginSchema.safeParse({
      username: 'head_teacher',
      password: 'correct-horse-battery-staple',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing username', () => {
    const result = LoginSchema.safeParse({ password: 'something' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (forbidNonWhitelisted equivalent)', () => {
    const result = LoginSchema.safeParse({
      username: 'head_teacher',
      password: 'something',
      role: 'head_teacher', // not a real field on the schema — must be rejected, not stripped silently
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password over 72 ASCII bytes', () => {
    const result = LoginSchema.safeParse({
      username: 'head_teacher',
      password: 'a'.repeat(73),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password that is under 72 characters but over 72 bytes due to multi-byte UTF-8', () => {
    // Arabic letters encode to 2 bytes each in UTF-8: 40 chars = 80 bytes,
    // which a naive `.max(72)` on string length would wrongly accept.
    const arabicPassword = 'ا'.repeat(40);
    expect(arabicPassword.length).toBeLessThan(72);
    expect(Buffer.byteLength(arabicPassword, 'utf8')).toBeGreaterThan(72);

    const result = LoginSchema.safeParse({
      username: 'head_teacher',
      password: arabicPassword,
    });
    expect(result.success).toBe(false);
  });
});
