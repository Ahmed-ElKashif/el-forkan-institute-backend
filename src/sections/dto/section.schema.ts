import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '../../common/pagination';

const GENDERS = ['male', 'female'] as const;
const DELIVERY_MODES = ['onsite', 'online', 'hybrid'] as const;
const ATTEND_MODES = ['onsite', 'online'] as const;
const ENTRY_TYPES = [
  'new',
  'promoted',
  'promoted_with_carry',
  'repeater',
  'skipped_prep',
  'transfer',
] as const;
const ENROLLMENT_STATUSES = ['active', 'completed', 'withdrawn'] as const;

// R3: a section is per branch × year × level × gender. The gender is part of
// the section's identity, not an attribute of it — `sections` carries
// UNIQUE (id, gender) so `enrollments` and `section_teachers` can point at the
// pair with a composite FK and make a mixed roster impossible (spec §5.1).
export const CreateSectionSchema = z
  .object({
    branchId: z.number().int().positive(),
    academicYearId: z.number().int().positive(),
    levelId: z.number().int().positive(),
    gender: z.enum(GENDERS),
    name: z.string().trim().min(1).max(120),
    defaultMode: z.enum(DELIVERY_MODES).default('onsite'),
    supervisorId: z.uuid().nullable().default(null),
    whatsappGroupId: z.string().trim().max(120).nullable().default(null),
    capacity: z.number().int().min(1).max(500).nullable().default(null),
  })
  .strict();

// branchId, academicYearId, levelId and gender are all absent: together they
// are the section's identity, and three of them are composite-FK targets that
// enrolments already point at.
export const UpdateSectionSchema = CreateSectionSchema.omit({
  branchId: true,
  academicYearId: true,
  levelId: true,
  gender: true,
})
  .strict()
  .partial();

export const ListSectionsQuerySchema = PageQuerySchema.extend({
  academicYearId: z.coerce.number().int().positive().optional(),
  levelId: z.coerce.number().int().positive().optional(),
  gender: z.enum(GENDERS).optional(),
  branchId: z.coerce.number().int().positive().optional(),
}).strict();

export const AssignTeacherSchema = z
  .object({
    userId: z.uuid(),
    // The DDL has a partial unique index allowing one primary per section.
    isPrimary: z.boolean().default(false),
  })
  .strict();

export const CreateEnrollmentSchema = z
  .object({
    studentId: z.uuid(),
    sectionId: z.uuid(),
    entryType: z.enum(ENTRY_TYPES).default('new'),
    defaultAttendanceMode: z.enum(ATTEND_MODES).default('onsite'),
  })
  .strict();

export const UpdateEnrollmentSchema = z
  .object({
    status: z.enum(ENROLLMENT_STATUSES),
    defaultAttendanceMode: z.enum(ATTEND_MODES),
  })
  .strict()
  .partial();

export const ListEnrollmentsQuerySchema = PageQuerySchema.extend({
  sectionId: z.uuid().optional(),
  studentId: z.uuid().optional(),
  academicYearId: z.coerce.number().int().positive().optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
}).strict();

// Moving a student to another section — the "study year is wrong" correction.
// Only the target section is named; the year, branch and gender are re-read from
// it (like create), and the service refuses a cross-year or cross-gender move.
export const TransferEnrollmentSchema = z
  .object({ sectionId: z.uuid() })
  .strict();

export class CreateSectionDto extends createZodDto(CreateSectionSchema) {}
export class UpdateSectionDto extends createZodDto(UpdateSectionSchema) {}
export class ListSectionsQueryDto extends createZodDto(
  ListSectionsQuerySchema,
) {}
export class AssignTeacherDto extends createZodDto(AssignTeacherSchema) {}
export class CreateEnrollmentDto extends createZodDto(CreateEnrollmentSchema) {}
export class UpdateEnrollmentDto extends createZodDto(UpdateEnrollmentSchema) {}
export class TransferEnrollmentDto extends createZodDto(TransferEnrollmentSchema) {}
export class ListEnrollmentsQueryDto extends createZodDto(
  ListEnrollmentsQuerySchema,
) {}
