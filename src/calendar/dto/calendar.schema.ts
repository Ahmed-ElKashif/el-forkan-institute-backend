import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { DateOnlySchema } from '../../common/date-only.schema';
import { PageQuerySchema } from '../../common/pagination';

const PERIOD_STATUSES = ['planned', 'active', 'closed'] as const;

// The institute has run since well before this system; a Hijri year outside
// this range is a typo, not history.
const HijriYearSchema = z.number().int().min(1400).max(1500);

// Dates are optional: omitting them asks the server to suggest them from
// institute_settings and the Umm al-Qura calendar (spec §7.5). Supplying them
// is the head teacher overriding that suggestion, which is the documented
// escape hatch for Egypt's calculation differing by a day.
export const CreateAcademicYearSchema = z
  .object({
    hijriYear: HijriYearSchema,
    startsOn: DateOnlySchema.optional(),
    endsOn: DateOnlySchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.startsOn === undefined ||
      value.endsOn === undefined ||
      value.endsOn > value.startsOn,
    { message: 'endsOn must be after startsOn', path: ['endsOn'] },
  );

export const UpdateAcademicYearSchema = z
  .object({
    startsOn: DateOnlySchema,
    endsOn: DateOnlySchema,
    status: z.enum(PERIOD_STATUSES),
  })
  .strict()
  .partial();

export const UpdateTermSchema = z
  .object({
    startsOn: DateOnlySchema,
    endsOn: DateOnlySchema,
    examStartsOn: DateOnlySchema.nullable(),
    examEndsOn: DateOnlySchema.nullable(),
    status: z.enum(PERIOD_STATUSES),
  })
  .strict()
  .partial();

export const ListAcademicYearsQuerySchema = PageQuerySchema.strict();

export class CreateAcademicYearDto extends createZodDto(
  CreateAcademicYearSchema,
) {}
export class UpdateAcademicYearDto extends createZodDto(
  UpdateAcademicYearSchema,
) {}
export class UpdateTermDto extends createZodDto(UpdateTermSchema) {}
export class ListAcademicYearsQueryDto extends createZodDto(
  ListAcademicYearsQuerySchema,
) {}
