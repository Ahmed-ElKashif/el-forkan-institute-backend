import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ArabicNameSchema } from '../../common/arabic-name.schema';
import { DateOnlySchema } from '../../common/date-only.schema';
import { PageQuerySchema } from '../../common/pagination';
import { PhoneSchema } from '../../common/phone';

const GENDERS = ['male', 'female'] as const;
const STUDENT_STATUSES = [
  'active',
  'graduated',
  'withdrawn',
  'suspended',
] as const;
const PLACEMENT_METHODS = ['entrance_exam', 'recommendation'] as const;

// Egyptian national IDs are 14 digits. Validated but never logged, and stored
// only as AES-256-GCM ciphertext (spec §9).
const NationalIdSchema = z
  .string()
  .trim()
  .regex(/^\d{14}$/, 'An Egyptian national ID is 14 digits');

// Optional because the institute's existing rosters are names-only: ~96
// students with almost no phone numbers (spec §1). Requiring a phone here
// would make the historical import impossible.
export const CreateStudentSchema = z
  .object({
    fullName: ArabicNameSchema,
    gender: z.enum(GENDERS),
    branchId: z.number().int().positive().nullable().default(null),
    // student_code is generated when omitted; §10 item 3 leaves the format to
    // the institute, so an explicit value always wins.
    studentCode: z.string().trim().min(1).max(40).optional(),
    phone: PhoneSchema.nullable().optional(),
    whatsappPhone: PhoneSchema.nullable().optional(),
    governorateId: z.number().int().positive().nullable().optional(),
    markazId: z.number().int().positive().nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    birthDate: DateOnlySchema.nullable().optional(),
    nationalId: NationalIdSchema.nullable().optional(),
    whatsappOptIn: z.boolean().default(true),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

// gender is absent: `students` carries UNIQUE (id, gender) as the target of
// the composite FKs on `enrollments`, so changing it on an enrolled student
// would have to cascade through every roster they appear on (spec §5.1).
export const UpdateStudentSchema = CreateStudentSchema.omit({ gender: true })
  .extend({ status: z.enum(STUDENT_STATUSES) })
  .partial();

export const ListStudentsQuerySchema = PageQuerySchema.extend({
  search: z.string().trim().min(1).max(160).optional(),
  gender: z.enum(GENDERS).optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  markazId: z.coerce.number().int().positive().optional(),
  // A student's "study year" is the level of their enrollment in this year.
  // levelId filters to students enrolled at that level; academicYearId overrides
  // which year is "current" (defaults to the newest year, resolved server-side).
  levelId: z.coerce.number().int().positive().optional(),
  academicYearId: z.coerce.number().int().positive().optional(),
  // §6.4: teachers fill phone and markaz manually after the historical
  // import, so "who is still missing a number" is a working list.
  missingPhone: z.stringbool().default(false),
}).strict();

/**
 * §4.7 — both routes into a level. The CHECK constraints in the DDL enforce
 * the same shape; mirroring them here turns an unmapped driver error into a
 * field-level 400.
 */
export const CreatePlacementSchema = z
  .object({
    method: z.enum(PLACEMENT_METHODS),
    placedLevelId: z.number().int().positive(),
    score: z.number().min(0).max(9999.99).nullable().default(null),
    maxScore: z.number().min(0).max(9999.99).nullable().default(null),
    passScore: z.number().min(0).max(9999.99).nullable().default(null),
    recommendedBy: z.uuid().nullable().default(null),
    assessedOn: DateOnlySchema.optional(),
    notes: z.string().trim().max(2000).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.method !== 'entrance_exam' ||
      (value.score !== null &&
        value.maxScore !== null &&
        value.passScore !== null),
    {
      message: 'An entrance exam must record score, maxScore and passScore',
      path: ['score'],
    },
  )
  .refine(
    (value) =>
      value.method !== 'recommendation' || value.recommendedBy !== null,
    {
      message: 'A recommendation must name the teacher who gave it',
      path: ['recommendedBy'],
    },
  )
  .refine(
    (value) =>
      value.passScore === null ||
      value.maxScore === null ||
      value.passScore <= value.maxScore,
    { message: 'passScore must not exceed maxScore', path: ['passScore'] },
  );

export class CreateStudentDto extends createZodDto(CreateStudentSchema) {}
export class UpdateStudentDto extends createZodDto(UpdateStudentSchema) {}
export class ListStudentsQueryDto extends createZodDto(
  ListStudentsQuerySchema,
) {}
export class CreatePlacementDto extends createZodDto(CreatePlacementSchema) {}
