import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { NewPasswordSchema } from '../../common/password.schema';
import { OTP_CODE_LENGTH } from '../auth.constants';

// Step two: the challenge id from step one, the emailed code, and the new
// password. NewPasswordSchema enforces the same strength the head teacher's
// create/reset flows require (min 10 chars, ≤72 bytes).
export const PasswordResetConfirmSchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z.string().trim().regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`)),
    newPassword: NewPasswordSchema,
  })
  .strict();

export class PasswordResetConfirmDto extends createZodDto(
  PasswordResetConfirmSchema,
) {}
