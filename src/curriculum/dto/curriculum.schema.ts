import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const GRADING_MODES = ['score', 'pass_fail'] as const;
const ASSESSMENT_TYPES = [
  'written',
  'oral',
  'memorization',
  'research',
  'practical',
] as const;

const TermNumberSchema = z.union([z.literal(1), z.literal(2)]);
const ScoreSchema = z.number().min(0).max(9999.99);

// R12/R18: the head teacher owns max_score, pass_score, weight and the
// إلزامية flag. Defaults match the DDL so a row created with none of them
// behaves exactly as the schema documents.
const CurriculumBodySchema = z.object({
  subjectId: z.number().int().positive(),
  termNumber: TermNumberSchema,
  // NULL is a top-level مادة; a value nests this row under that parent
  // (spec §4.1). The composite FK forces parent and child to share
  // (year, level, term), so cross-level nesting is impossible by construction.
  parentCurriculumId: z.number().int().positive().nullable().default(null),
  isExaminable: z.boolean().default(true),
  isMandatory: z.boolean().default(false),
  gradingMode: z.enum(GRADING_MODES).default('score'),
  assessmentType: z.enum(ASSESSMENT_TYPES).default('written'),
  maxScore: ScoreSchema.default(100),
  passScore: ScoreSchema.default(50),
  weight: z.number().gt(0).max(999.99).default(1),
  teachingOrder: z.number().int().min(0).max(999).nullable().default(null),
});

const passMarkIsReachable = (value: { passScore: number; maxScore: number }) =>
  value.passScore <= value.maxScore;

const PASS_MARK_MESSAGE = {
  message: 'passScore must not exceed maxScore',
  path: ['passScore'],
};

export const CreateCurriculumSchema = CurriculumBodySchema.strict().refine(
  passMarkIsReachable,
  PASS_MARK_MESSAGE,
);

// subjectId and termNumber are absent: together with the year and level they
// are the row's identity (the DDL's UNIQUE), so changing either is a delete
// plus a create, not an edit.
export const UpdateCurriculumSchema = CurriculumBodySchema.omit({
  subjectId: true,
  termNumber: true,
})
  .strict()
  .partial();

export const ListCurriculumQuerySchema = z
  .object({
    levelId: z.coerce.number().int().positive().optional(),
    termNumber: z.coerce.number().int().pipe(TermNumberSchema).optional(),
  })
  .strict();

export const CreateCurriculumUnitSchema = z
  .object({
    bookId: z.number().int().positive().nullable().default(null),
    unitLabel: z.string().trim().min(1).max(120).nullable().default(null),
    syllabusScopeAr: z.string().trim().min(1).max(2000),
    // Same value on two units means the books are interchangeable — the
    // «أو» alternatives on the printed syllabus sheets.
    alternativeGroup: z.number().int().min(1).max(99).nullable().default(null),
    sortOrder: z.number().int().min(1).max(999).default(1),
  })
  .strict();

export const UpdateCurriculumUnitSchema = CreateCurriculumUnitSchema.partial();

export class CreateCurriculumDto extends createZodDto(CreateCurriculumSchema) {}
export class UpdateCurriculumDto extends createZodDto(UpdateCurriculumSchema) {}
export class ListCurriculumQueryDto extends createZodDto(
  ListCurriculumQuerySchema,
) {}
export class CreateCurriculumUnitDto extends createZodDto(
  CreateCurriculumUnitSchema,
) {}
export class UpdateCurriculumUnitDto extends createZodDto(
  UpdateCurriculumUnitSchema,
) {}
