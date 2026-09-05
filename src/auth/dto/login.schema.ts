import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PasswordSchema } from '../../common/password.schema';

// Staff sign in with email (F12): it is the same address the OTP is sent to, so
// there is one identity to remember. Normalised (trim + lowercase) before the
// lookup, since email addresses are case-insensitive and `users.email` is
// stored lowercase.
export const LoginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('A valid email is required')
      .max(254),
    password: PasswordSchema,
  })
  .strict();

export class LoginDto extends createZodDto(LoginSchema) {}
