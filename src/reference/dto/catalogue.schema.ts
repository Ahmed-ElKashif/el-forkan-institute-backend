import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '../../common/pagination';

const ArabicName = z.string().trim().min(2).max(160);

// R1 fixes the six levels and their order, so `code` and `sort_order` are
// identity, not attributes: there is no create or delete endpoint, and the
// editable fields are the rule flags the head teacher owns (R12, R15, R20).
export const UpdateLevelSchema = z
  .object({
    nameAr: ArabicName,
    isOptional: z.boolean(),
    isTerminal: z.boolean(),
    allowsCarry: z.boolean(),
    grantsCertificate: z.boolean(),
    requiresCleanEntry: z.boolean(),
  })
  .strict()
  .partial();

export const CreateSubjectSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(
        /^[A-Z][A-Z0-9_]*$/,
        'Use upper-case letters, digits and underscore',
      ),
    nameAr: ArabicName,
    shortNameAr: ArabicName.optional(),
    nameEn: z.string().trim().min(2).max(120).optional(),
  })
  .strict();

// `code` is referenced by seeds and imports; renaming it silently would break
// alias resolution. Deactivation replaces deletion — curriculum rows point
// here with ON DELETE RESTRICT.
export const UpdateSubjectSchema = CreateSubjectSchema.omit({ code: true })
  .extend({ isActive: z.boolean() })
  .partial();

export const CreateAliasSchema = z
  .object({ aliasAr: z.string().trim().min(2).max(160) })
  .strict();

export const CreateBookSchema = z
  .object({
    titleAr: ArabicName,
    authorAr: ArabicName.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export const UpdateBookSchema = CreateBookSchema.extend({
  isActive: z.boolean(),
}).partial();

export const ListSubjectsQuerySchema = PageQuerySchema.extend({
  search: z.string().trim().min(1).max(160).optional(),
  includeInactive: z.stringbool().default(false),
}).strict();

export class UpdateLevelDto extends createZodDto(UpdateLevelSchema) {}
export class CreateSubjectDto extends createZodDto(CreateSubjectSchema) {}
export class UpdateSubjectDto extends createZodDto(UpdateSubjectSchema) {}
export class CreateAliasDto extends createZodDto(CreateAliasSchema) {}
export class CreateBookDto extends createZodDto(CreateBookSchema) {}
export class UpdateBookDto extends createZodDto(UpdateBookSchema) {}
export class ListSubjectsQueryDto extends createZodDto(
  ListSubjectsQuerySchema,
) {}
