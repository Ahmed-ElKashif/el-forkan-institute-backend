import { z } from 'zod';

// bcrypt silently truncates at 72 BYTES (not characters) — a password with
// multi-byte UTF-8 characters (Arabic text, emoji, ...) can exceed 72 bytes
// well before 72 characters. Reject over the limit rather than let bcrypt
// truncate invisibly.
const MAX_PASSWORD_BYTES = 72;

export const PasswordSchema = z
  .string()
  .min(1, 'Password is required')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
    message: `Password must not exceed ${MAX_PASSWORD_BYTES} bytes`,
  });

// Minimum strength for a password the head teacher sets on someone else's
// behalf. Login deliberately does NOT apply this: an account created before
// the rule existed must still be able to sign in and change its password.
export const NewPasswordSchema = PasswordSchema.refine(
  (value) => value.length >= 10,
  { message: 'Password must be at least 10 characters' },
);
