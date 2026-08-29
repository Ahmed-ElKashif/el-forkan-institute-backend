import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PasswordSchema } from '../../common/password.schema';

export const LoginSchema = z
  .object({
    username: z.string().trim().min(1, 'Username is required').max(50),
    password: PasswordSchema,
  })
  .strict();

export class LoginDto extends createZodDto(LoginSchema) {}
