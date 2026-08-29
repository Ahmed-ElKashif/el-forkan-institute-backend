import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { DateOnlySchema } from '../../common/date-only.schema';

export const QueueReminderSchema = z
  .object({
    sectionId: z.uuid(),
    // The Friday whose schedule the reminder carries (R10). Explicit rather
    // than derived, so the head teacher can send for a moved lecture day.
    targetDate: DateOnlySchema,
  })
  .strict();

export const UpsertTemplateSchema = z
  .object({
    body: z.string().trim().min(5).max(2000),
    // §7.8: a business-initiated message outside the 24-hour window needs a
    // Meta-approved template, and the approved NAME is what the API takes.
    providerTemplateName: z.string().trim().max(120).nullable(),
    language: z.string().trim().min(2).max(10),
    isActive: z.boolean(),
  })
  .strict()
  .partial();

export class QueueReminderDto extends createZodDto(QueueReminderSchema) {}
export class UpsertTemplateDto extends createZodDto(UpsertTemplateSchema) {}
