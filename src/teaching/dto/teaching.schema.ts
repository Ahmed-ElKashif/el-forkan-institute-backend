import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { DateOnlySchema } from '../../common/date-only.schema';
import { PageQuerySchema } from '../../common/pagination';

const DELIVERY_MODES = ['onsite', 'online', 'hybrid'] as const;
const ATTEND_MODES = ['onsite', 'online'] as const;
const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'] as const;
const SESSION_STATUSES = ['scheduled', 'held', 'cancelled'] as const;

const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM in 24-hour time');

// R4: Friday is the default, not a hard rule — the weekday is per slot.
const IsoWeekdaySchema = z.number().int().min(1).max(7);

export const CreateTimetableSlotSchema = z
  .object({
    subjectId: z.number().int().positive(),
    teacherId: z.uuid().nullable().default(null),
    weekday: IsoWeekdaySchema.default(5),
    slotOrder: z.number().int().min(1).max(20),
    startsAt: TimeOfDaySchema,
    endsAt: TimeOfDaySchema,
    room: z.string().trim().max(60).nullable().default(null),
    mode: z.enum(DELIVERY_MODES).default('onsite'),
    effectiveFrom: DateOnlySchema.nullable().default(null),
    effectiveTo: DateOnlySchema.nullable().default(null),
  })
  .strict()
  .refine((value) => value.endsAt > value.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export const UpdateTimetableSlotSchema = z
  .object({
    teacherId: z.uuid().nullable(),
    weekday: IsoWeekdaySchema,
    slotOrder: z.number().int().min(1).max(20),
    startsAt: TimeOfDaySchema,
    endsAt: TimeOfDaySchema,
    room: z.string().trim().max(60).nullable(),
    mode: z.enum(DELIVERY_MODES),
    effectiveFrom: DateOnlySchema.nullable(),
    effectiveTo: DateOnlySchema.nullable(),
  })
  .strict()
  .partial();

export const GenerateSessionsSchema = z
  .object({
    termId: z.number().int().positive(),
    // Institute holidays. A slot landing on one is skipped and the numbering
    // continues, so a closure does not consume one of the fifteen columns.
    offDays: z.array(DateOnlySchema).max(60).default([]),
  })
  .strict();

export const UpdateSessionSchema = z
  .object({
    sessionDate: DateOnlySchema,
    startsAt: TimeOfDaySchema,
    endsAt: TimeOfDaySchema,
    mode: z.enum(DELIVERY_MODES),
    room: z.string().trim().max(60).nullable(),
    meetingUrl: z.url().max(500).nullable(),
    teacherId: z.uuid().nullable(),
    status: z.enum(SESSION_STATUSES),
    cancelReason: z.string().trim().max(500).nullable(),
  })
  .strict()
  .partial();
// Two invariants are deliberately NOT enforced here — the DDL's
// CHECK (mode <> 'online' OR meeting_url IS NOT NULL OR status = 'cancelled'),
// and "a cancellation needs a reason". Both depend on the session's *current*
// values: PATCHing mode:'online' onto a session that already has a meeting URL
// is legal, and a .partial() schema cannot tell an omitted field from a
// cleared one. SessionsService.update checks them against the merged row.

export const ListSessionsQuerySchema = PageQuerySchema.extend({
  sectionId: z.uuid().optional(),
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
  status: z.enum(SESSION_STATUSES).optional(),
}).strict();

/**
 * The attendance grid saves a whole session's column in one request (§8 Phase
 * 3, "attendance as a student × session grid"). One row per student would be
 * 30 requests per class and would leave the grid half-saved if the teacher's
 * connection dropped mid-way.
 */
export const SaveAttendanceSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            enrollmentId: z.uuid(),
            status: z.enum(ATTENDANCE_STATUSES),
            // R4: "an individual student may attend a hybrid session online".
            attendedMode: z.enum(ATTEND_MODES).nullable().default(null),
            minutesLate: z
              .number()
              .int()
              .min(0)
              .max(600)
              .nullable()
              .default(null),
            note: z.string().trim().max(500).nullable().default(null),
          })
          .strict()
          // Mirrors CHECK (status <> 'absent' OR attended_mode IS NULL): an
          // absent student did not attend in any mode.
          .refine(
            (entry) => entry.status !== 'absent' || entry.attendedMode === null,
            {
              message: 'An absent student has no attendance mode',
              path: ['attendedMode'],
            },
          ),
      )
      .min(1)
      .max(500),
  })
  .strict();

export class CreateTimetableSlotDto extends createZodDto(
  CreateTimetableSlotSchema,
) {}
export class UpdateTimetableSlotDto extends createZodDto(
  UpdateTimetableSlotSchema,
) {}
export class GenerateSessionsDto extends createZodDto(GenerateSessionsSchema) {}
export class UpdateSessionDto extends createZodDto(UpdateSessionSchema) {}
export class ListSessionsQueryDto extends createZodDto(
  ListSessionsQuerySchema,
) {}
export class SaveAttendanceDto extends createZodDto(SaveAttendanceSchema) {}
