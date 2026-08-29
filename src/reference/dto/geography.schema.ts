import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '../../common/pagination';

const ArabicName = z.string().trim().min(2).max(120);
const LatinName = z.string().trim().min(2).max(120);

export const CreateGovernorateSchema = z
  .object({ nameAr: ArabicName, nameEn: LatinName.optional() })
  .strict();
export const UpdateGovernorateSchema = CreateGovernorateSchema.partial();

export const CreateMarkazSchema = z
  .object({
    governorateId: z.number().int().positive(),
    nameAr: ArabicName,
    nameEn: LatinName.optional(),
  })
  .strict();
// governorateId is absent: a markaz that moved governorate is a different
// markaz, and students already point at this row.
export const UpdateMarkazSchema = CreateMarkazSchema.omit({
  governorateId: true,
}).partial();

export const CreateBranchSchema = z
  .object({
    nameAr: ArabicName,
    governorateId: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const UpdateBranchSchema = z
  .object({
    nameAr: ArabicName,
    governorateId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
  })
  .strict()
  .partial();

export const ListMarkazesQuerySchema = PageQuerySchema.extend({
  governorateId: z.coerce.number().int().positive().optional(),
}).strict();

export class CreateGovernorateDto extends createZodDto(
  CreateGovernorateSchema,
) {}
export class UpdateGovernorateDto extends createZodDto(
  UpdateGovernorateSchema,
) {}
export class CreateMarkazDto extends createZodDto(CreateMarkazSchema) {}
export class UpdateMarkazDto extends createZodDto(UpdateMarkazSchema) {}
export class CreateBranchDto extends createZodDto(CreateBranchSchema) {}
export class UpdateBranchDto extends createZodDto(UpdateBranchSchema) {}
export class ListMarkazesQueryDto extends createZodDto(
  ListMarkazesQuerySchema,
) {}
export class PageQueryDto extends createZodDto(PageQuerySchema.strict()) {}
