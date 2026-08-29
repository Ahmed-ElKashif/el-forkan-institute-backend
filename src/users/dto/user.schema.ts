import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { NewPasswordSchema } from '../../common/password.schema';
import { PageQuerySchema } from '../../common/pagination';
import { PhoneSchema } from '../../common/phone';

const ROLES = ['head_teacher', 'teacher'] as const;
const GENDERS = ['male', 'female'] as const;

export const CreateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    // Login identifier (spec §5.1). Restricted to ASCII so it can never be
    // two visually identical usernames that differ by an Arabic form or a
    // zero-width character.
    username: z
      .string()
      .trim()
      .min(3)
      .max(50)
      .regex(
        /^[a-zA-Z0-9._-]+$/,
        'Use letters, digits, dot, underscore or dash',
      ),
    gender: z.enum(GENDERS),
    phone: PhoneSchema,
    email: z.email().max(180).optional(),
    password: NewPasswordSchema,
    role: z.enum(ROLES).default('teacher'),
    // NULL means institute-wide (spec §3): only meaningful for a head teacher.
    branchId: z.number().int().positive().nullable().default(null),
  })
  .strict();

// gender and username are deliberately absent. gender is the target of the
// composite foreign keys that make cross-gender rosters structurally
// impossible (spec §5.1), so changing it on a user who already teaches a
// section would have to cascade; username is the login identifier, and
// silently moving it is an account-takeover shape. Both are recreate-only.
export const UpdateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    phone: PhoneSchema,
    email: z.email().max(180).nullable(),
    role: z.enum(ROLES),
    branchId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
  })
  .strict()
  .partial();

export const ListUsersQuerySchema = PageQuerySchema.extend({
  role: z.enum(ROLES).optional(),
  gender: z.enum(GENDERS).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  includeInactive: z.stringbool().default(false),
}).strict();

export class CreateUserDto extends createZodDto(CreateUserSchema) {}
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
export class ListUsersQueryDto extends createZodDto(ListUsersQuerySchema) {}
