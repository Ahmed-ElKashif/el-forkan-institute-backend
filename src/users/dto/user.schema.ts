import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  NewPasswordSchema,
  PasswordSchema,
} from '../../common/password.schema';
import { PageQuerySchema } from '../../common/pagination';
import { PhoneSchema } from '../../common/phone';

const ROLES = ['head_teacher', 'teacher'] as const;
const GENDERS = ['male', 'female'] as const;

// A display handle, unique per user. Restricted to ASCII so it can never be two
// visually identical usernames that differ by an Arabic form or a zero-width
// character. NOT the login credential — staff sign in with their email.
const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(50)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, underscore or dash');

export const CreateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    username: UsernameSchema,
    gender: z.enum(GENDERS),
    phone: PhoneSchema,
    // Required since F12: email is the login identity (staff sign in with it and
    // the OTP is sent to it), so an account without one could never log in.
    // Normalised to trimmed lowercase to match how login looks it up.
    email: z.string().trim().toLowerCase().email().max(180),
    password: NewPasswordSchema,
    role: z.enum(ROLES).default('teacher'),
    // NULL means institute-wide (spec §3): only meaningful for a head teacher.
    branchId: z.number().int().positive().nullable().default(null),
  })
  .strict();

// gender is editable, but it is the target of the composite FK that keeps a
// teacher's gender matched to the classes they teach (spec §5.1) — so the
// service refuses to change it while the user is assigned to a class (409),
// where changing it would strand the assignment. username is editable too: login
// is by email, so a username is just a display handle; a collision returns 409.
export const UpdateUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    username: UsernameSchema,
    gender: z.enum(GENDERS),
    phone: PhoneSchema,
    email: z.string().trim().toLowerCase().email().max(180).nullable(),
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

// F10: self-service password change. The current password is required — a
// stolen access token alone must not be enough to lock the real owner out by
// changing their password. It is validated only for presence (PasswordSchema),
// not strength: an old account may predate the strength rule.
export const ChangePasswordSchema = z
  .object({
    currentPassword: PasswordSchema,
    newPassword: NewPasswordSchema,
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  });

// F10: head-teacher-initiated reset of another user's password, so a
// compromised teacher account can be rotated without recreating it.
export const ResetPasswordSchema = z
  .object({ newPassword: NewPasswordSchema })
  .strict();

export class CreateUserDto extends createZodDto(CreateUserSchema) {}
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
export class ListUsersQueryDto extends createZodDto(ListUsersQuerySchema) {}
