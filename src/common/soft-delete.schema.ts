import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// R9: only the head teacher may delete a person, soft, and the reason is not
// optional — a deletion with no stated reason is indistinguishable from an
// accident when someone reads the audit log a year later.
export const DeleteWithReasonSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export class DeleteWithReasonDto extends createZodDto(DeleteWithReasonSchema) {}
