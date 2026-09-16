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

// A period's gender scope. `both` — the sheikh teaches boys and girls at the
// same time (girls in a separate room on speakers); it materialises as one
// session per gendered cohort so each keeps its own attendance. `male`/`female`
// — the period runs for that cohort only.
const PERIOD_GENDER_SCOPES = ['both', 'male', 'female'] as const;

const ClassDayPeriodSchema = z
  .object({
    subjectId: z.number().int().positive(),
    slotOrder: z.number().int().min(1).max(20),
    startsAt: TimeOfDaySchema,
    endsAt: TimeOfDaySchema,
    sheikhName: z.string().trim().max(120).nullable().default(null),
    genderScope: z.enum(PERIOD_GENDER_SCOPES).default('both'),
  })
  .strict()
  .refine((value) => value.endsAt > value.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

// A class day: one calendar date and the periods held on it, created by hand
// for a level (both cohorts). Unlike GenerateSessions this is not derived from
// a recurring timetable — the institute schedules each Friday as it comes.
export const CreateClassDaySchema = z
  .object({
    academicYearId: z.number().int().positive(),
    sessionDate: DateOnlySchema,
    periods: z.array(ClassDayPeriodSchema).min(1).max(20),
  })
  .strict();

// The attendance grid is read either for a whole term (the printed sheet's
// 1…15 columns) or for a single class day (one Friday's periods). `termId`
// anchors the running absence count in both cases; `date`, when given, narrows
// the columns to that day.
export const AttendanceGridQuerySchema = z
  .object({
    termId: z.coerce.number().int().positive(),
    date: DateOnlySchema.optional(),
  })
  .strict();

export const UpdateSessionSchema = z
  .object({
    // Editing a class-day period: its subject, times, and the sheikh who teaches
    // it. The rest are the older reschedule/cancel fields.
    subjectId: z.number().int().positive(),
    sheikhName: z.string().trim().max(120).nullable(),
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

export class CreateClassDayDto extends createZodDto(CreateClassDaySchema) {}
export class AttendanceGridQueryDto extends createZodDto(
  AttendanceGridQuerySchema,
) {}
export class UpdateSessionDto extends createZodDto(UpdateSessionSchema) {}
export class ListSessionsQueryDto extends createZodDto(
  ListSessionsQuerySchema,
) {}
export class SaveAttendanceDto extends createZodDto(SaveAttendanceSchema) {}
