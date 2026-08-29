import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '../../common/pagination';

const EXCEED_ACTIONS = ['warn_only', 'block_exam'] as const;
const FAILURE_COUNTING_UNITS = ['leaf', 'parent'] as const;

// R13: the carry limit is per level, seeded at 3 from observed 1447 behaviour.
// level_id NULL is the year's fallback for levels with no explicit row.
export const UpsertProgressionRuleSchema = z
  .object({
    levelId: z.number().int().positive().nullable().default(null),
    maxCarriedSubjects: z.number().int().min(0).max(20).default(3),
    makeupRoundEnabled: z.boolean().default(true),
    carryForwardEnabled: z.boolean().default(true),
    // R17: an إلزامية failure blocks promotion. Defaulting this to true would
    // silently restore the looser pre-v1.1 behaviour.
    mandatoryCanBeCarried: z.boolean().default(false),
    // R14: sub-subjects are examined and carried individually, so failures are
    // counted at the leaf.
    failureCountingUnit: z.enum(FAILURE_COUNTING_UNITS).default('leaf'),
  })
  .strict();

export const UpsertAttendancePolicySchema = z
  .object({
    levelId: z.number().int().positive().nullable().default(null),
    maxAbsences: z.number().int().min(1).max(60).default(4),
    warnAtAbsences: z.number().int().min(1).max(60).default(3),
    autoWarnEnabled: z.boolean().default(true),
    exceedingAction: z.enum(EXCEED_ACTIONS).default('warn_only'),
  })
  .strict()
  // Mirrors the DDL's CHECK. Enforcing it here turns an unmapped driver error
  // into a field-level 400 the head teacher can act on.
  .refine((value) => value.warnAtAbsences < value.maxAbsences, {
    message: 'warnAtAbsences must be below maxAbsences',
    path: ['warnAtAbsences'],
  });

const HijriMonthSchema = z.number().int().min(1).max(12);
const HijriDaySchema = z.number().int().min(1).max(30);
const IsoWeekdaySchema = z.number().int().min(1).max(7);

export const UpdateInstituteSettingsSchema = z
  .object({
    nameAr: z.string().trim().min(2).max(200),
    defaultLectureWeekday: IsoWeekdaySchema,
    timezone: z.string().trim().min(3).max(60),
    yearStartHijriMonth: HijriMonthSchema,
    yearStartHijriDay: HijriDaySchema,
    yearEndHijriMonth: HijriMonthSchema,
    yearEndHijriDay: HijriDaySchema,
    sessionsPerTerm: z.number().int().min(1).max(60),
    defaultMaxScore: z.number().min(1).max(9999.99),
    defaultPassScore: z.number().min(0).max(9999.99),
    placementDefaultMax: z.number().min(1).max(9999.99),
    placementDefaultPass: z.number().min(0).max(9999.99),
    reminderWeekday: IsoWeekdaySchema,
    reminderSendTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM in 24-hour time'),
    // Identifiers only — the WhatsApp access token lives in env, never in the
    // database (spec §7.8).
    whatsappBusinessPhone: z.string().trim().max(30).nullable(),
    whatsappPhoneNumberId: z.string().trim().max(60).nullable(),
    whatsappOwnerUserId: z.uuid().nullable(),
  })
  .strict()
  .partial();

export const ListAuditLogsQuerySchema = PageQuerySchema.extend({
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.string().trim().min(1).max(60).optional(),
  actorId: z.uuid().optional(),
  action: z.string().trim().min(1).max(80).optional(),
}).strict();

export class UpsertProgressionRuleDto extends createZodDto(
  UpsertProgressionRuleSchema,
) {}
export class UpsertAttendancePolicyDto extends createZodDto(
  UpsertAttendancePolicySchema,
) {}
export class UpdateInstituteSettingsDto extends createZodDto(
  UpdateInstituteSettingsSchema,
) {}
export class ListAuditLogsQueryDto extends createZodDto(
  ListAuditLogsQuerySchema,
) {}
