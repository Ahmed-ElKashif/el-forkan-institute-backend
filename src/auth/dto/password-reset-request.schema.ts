import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// Step one of a self-service reset (F12): just the email the code is sent to,
// normalised the same way login normalises it.
export const PasswordResetRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export class PasswordResetRequestDto extends createZodDto(
  PasswordResetRequestSchema,
) {}
