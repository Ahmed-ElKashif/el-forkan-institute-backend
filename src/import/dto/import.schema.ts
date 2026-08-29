import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '../../common/pagination';

// §6.4 imports the roster sheets and the result sheets separately: they are
// different files with different columns, and the roster has to land first so
// the results have students to attach to.
export const IMPORT_TYPES = ['roster', 'results'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/**
 * Multipart fields arrive as strings, so every number here is coerced.
 * `sectionIdByGender` maps the sheet's gender to the section its rows belong
 * to — the sheet says إخوة or أخوات, but only the head teacher knows which
 * section that is for this file.
 */
export const StartImportSchema = z
  .object({
    importType: z.enum(IMPORT_TYPES),
    branchId: z.coerce.number().int().positive(),
    academicYearId: z.coerce.number().int().positive(),
    maleSectionId: z.uuid().optional(),
    femaleSectionId: z.uuid().optional(),
    // §6.4: the 1447 back-fill writes enrollments with is_historical = TRUE,
    // and the promotion engine must never re-decide those rows.
    isHistorical: z.stringbool().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.maleSectionId !== undefined || value.femaleSectionId !== undefined,
    {
      message: 'Name at least one section for the sheets in this file',
      path: ['maleSectionId'],
    },
  );

// The preview exists so a teacher can fix rows before anything is written
// (§6.3). Only the fields a human can correct are editable.
export const FixImportRowSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    markazId: z.number().int().positive().nullable().optional(),
    matchStudentId: z.uuid().nullable().optional(),
    // Lets a reviewer resolve a subject the aliases could not, or drop a row.
    subjectIds: z.array(z.number().int().positive()).max(30).optional(),
    action: z.enum(['create', 'update', 'skip']).optional(),
  })
  .strict();

export const ListImportRowsQuerySchema = PageQuerySchema.extend({
  action: z.enum(['create', 'update', 'skip', 'error']).optional(),
}).strict();

export class StartImportDto extends createZodDto(StartImportSchema) {}
export class FixImportRowDto extends createZodDto(FixImportRowSchema) {}
export class ListImportRowsQueryDto extends createZodDto(
  ListImportRowsQuerySchema,
) {}
