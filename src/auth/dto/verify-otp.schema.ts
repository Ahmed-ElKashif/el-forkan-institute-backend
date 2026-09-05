import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { OTP_CODE_LENGTH } from '../auth.constants';

// Second step of login (F12): the challenge id handed back by /auth/login, and
// the six-digit code from the email. The code is validated as exactly N digits
// so a malformed guess is rejected before it costs one of the challenge's
// attempts.
export const VerifyOtpSchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z.string().trim().regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`)),
  })
  .strict();

export class VerifyOtpDto extends createZodDto(VerifyOtpSchema) {}
