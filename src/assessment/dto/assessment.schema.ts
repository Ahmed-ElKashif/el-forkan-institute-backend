import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '../../common/pagination';

const EXAM_TYPES = ['term_1', 'term_2', 'makeup', 'placement'] as const;
const GENDERS = ['male', 'female'] as const;

export const CreateExamSchema = z
  .object({
    branchId: z.number().int().positive(),
    termId: z.number().int().positive(),
    // §4.2: the exam points at an examinable curriculum row and inherits its
    // max/pass score from it, so neither is accepted here — an exam's pass
    // mark can never drift from the syllabus's.
    curriculumId: z.number().int().positive(),
    // NULL is a shared sitting for both genders (R3).
    gender: z.enum(GENDERS).nullable().default(null),
    examType: z.enum(EXAM_TYPES),
    scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null),
    durationMin: z.number().int().min(5).max(600).nullable().default(null),
    venue: z.string().trim().max(160).nullable().default(null),
  })
  .strict();

export const UpdateExamSchema = z
  .object({
    scheduledAt: z.iso.datetime({ offset: true }).nullable(),
    durationMin: z.number().int().min(5).max(600).nullable(),
    venue: z.string().trim().max(160).nullable(),
  })
  .strict()
  .partial();

export const ListExamsQuerySchema = PageQuerySchema.extend({
  termId: z.coerce.number().int().positive().optional(),
  examType: z.enum(EXAM_TYPES).optional(),
  levelId: z.coerce.number().int().positive().optional(),
  isLocked: z.stringbool().optional(),
}).strict();

// §4.6: eligibility is materialised and overridable, and an override must say
// why — the reason is what an auditor reads a year later.
export const OverrideEligibilitySchema = z
  .object({
    isEligible: z.boolean(),
    reasonNote: z.string().trim().min(3).max(500),
    seatNo: z.string().trim().max(20).nullable().default(null),
  })
  .strict();

/**
 * The score grid saves a whole exam in one request, for the same reason the
 * attendance grid does: one request per student would leave a paper
 * half-entered if the connection dropped.
 */
export const SaveScoresSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            enrollmentId: z.uuid(),
            score: z.number().min(0).max(9999.99).nullable().default(null),
            isAbsent: z.boolean().default(false),
          })
          .strict()
          // Mirrors CHECK (NOT is_absent OR score IS NULL): an absent student
          // has no mark, and recording one would turn "did not sit" into a
          // result (§4.2).
          .refine((entry) => !entry.isAbsent || entry.score === null, {
            message: 'An absent student has no score',
            path: ['score'],
          }),
      )
      .min(1)
      .max(500),
  })
  .strict();

// R8: only the head teacher may change a grade after entry, and the reason is
// mandatory — the whole point of grade_changes.
export const CorrectScoreSchema = z
  .object({
    score: z.number().min(0).max(9999.99).nullable(),
    isAbsent: z.boolean().default(false),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((value) => !value.isAbsent || value.score === null, {
    message: 'An absent student has no score',
    path: ['score'],
  });

/* The five verdicts §4.3 can reach. `decision_t` also carries `withdrawn`,
   which is an enrolment status rather than a promotion outcome — offering it
   here would let a run mark a student withdrawn without anyone withdrawing
   them. */
const PROMOTION_DECISIONS = [
  'promote',
  'promote_with_carry',
  'repeat',
  'makeup_required',
  'graduate',
] as const;

// Mirrors OverrideEligibilitySchema: the reason is mandatory and held to a real
// minimum, because it is what the audit log records.
export const OverridePromotionSchema = z
  .object({
    decision: z.enum(PROMOTION_DECISIONS),
    // The round this override belongs to; §4.3 decides differently either side
    // of the makeup, so an override is scoped to one of them.
    afterMakeup: z.boolean().default(false),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const RunPromotionSchema = z
  .object({
    academicYearId: z.number().int().positive(),
    levelId: z.number().int().positive().optional(),
    // §4.3 runs in two rounds; the caller says which one this is.
    afterMakeup: z.boolean().default(false),
  })
  .strict();

export const ConfirmPromotionSchema = RunPromotionSchema.extend({
  // The preview is not advisory: confirming replays the same computation and
  // writes it. Naming the enrolments makes the confirm apply exactly what was
  // reviewed, not whatever the engine decides a second time.
  enrollmentIds: z.array(z.uuid()).min(1).max(500),
  // §8 Phase 4: the confirm creates next year's enrolments, and a carry can
  // only exist against one (the DDL forbids a carry pointing at the enrolment
  // that produced it). Omitting this records the decisions but moves nobody
  // forward — useful when next year's sections do not exist yet.
  targetAcademicYearId: z.number().int().positive().optional(),
}).strict();

export const IssueCertificateSchema = z
  .object({
    studentId: z.uuid(),
    levelId: z.number().int().positive(),
    enrollmentId: z.uuid().nullable().default(null),
    serialNo: z.string().trim().max(60).nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
  })
  .strict();

// R19 / §4.5: revocation requires a reason and is audited.
export const RevokeCertificateSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export class CreateExamDto extends createZodDto(CreateExamSchema) {}
export class UpdateExamDto extends createZodDto(UpdateExamSchema) {}
export class ListExamsQueryDto extends createZodDto(ListExamsQuerySchema) {}
export class OverrideEligibilityDto extends createZodDto(
  OverrideEligibilitySchema,
) {}
export class SaveScoresDto extends createZodDto(SaveScoresSchema) {}
export class CorrectScoreDto extends createZodDto(CorrectScoreSchema) {}
export class RunPromotionDto extends createZodDto(RunPromotionSchema) {}
export class OverridePromotionDto extends createZodDto(
  OverridePromotionSchema,
) {}
export class ConfirmPromotionDto extends createZodDto(ConfirmPromotionSchema) {}
export class IssueCertificateDto extends createZodDto(IssueCertificateSchema) {}
export class RevokeCertificateDto extends createZodDto(
  RevokeCertificateSchema,
) {}
