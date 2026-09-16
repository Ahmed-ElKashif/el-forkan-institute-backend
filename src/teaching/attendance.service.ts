import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import { canAccessSection } from '../common/access-scope';
import { AuditService } from '../common/audit.service';
import { toDateOnlyString } from '../common/date-only.schema';
import { PrismaService } from '../prisma/prisma.service';
import { assessAbsences } from '../rules/absence';
import { resolveProgressionRules } from '../rules/promotion';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { SaveAttendanceDto } from './dto/teaching.schema';

/**
 * §8 Phase 3 — attendance as a student × session grid, shaped like the printed
 * sheet (§6.1's numbered columns 1…15).
 *
 * The grid is read in one query and written in one transaction. A grid built
 * from one query per student would be 30 round-trips to render a class the
 * teacher is looking at on a phone.
 */

export interface AttendanceCell {
  sessionId: string;
  sessionNo: number | null;
  status: string | null;
  attendedMode: string | null;
  minutesLate: number | null;
  note: string | null;
}

export interface AttendanceGridRow {
  enrollmentId: string;
  studentName: string;
  studentCode: string;
  defaultAttendanceMode: string;
  cells: AttendanceCell[];
  absenceCount: number;
}

export interface AttendanceGrid {
  sectionId: string;
  sessions: Array<{
    id: string;
    sessionNo: number | null;
    sessionDate: string;
    startsAt: string;
    subjectNameAr: string;
    sheikhName: string | null;
    mode: string;
    status: string;
  }>;
  rows: AttendanceGridRow[];
}

export interface AbsenceWarningSummary {
  enrollmentId: string;
  studentName: string;
  absenceCount: number;
  threshold: number | null;
  blocksExams: boolean;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The whole grid: one query for sessions, one for enrolments-with-attendance.
   * Attendance rows are keyed by session so a student with no record yet
   * renders as an empty cell rather than being missing from the row.
   *
   * `date` narrows the columns to a single class day (the per-Friday view) while
   * the absence count still spans the whole term — so a day's marking shows the
   * student's running term total, not just that day's. Without it the grid is
   * the printed term sheet (columns 1…15).
   */
  async getGrid(
    sectionId: string,
    query: { termId: number; date?: Date },
    viewer: AuthenticatedUser,
  ): Promise<AttendanceGrid> {
    await this.assertSectionAccess(sectionId, viewer);
    const term = await this.prisma.terms.findUniqueOrThrow({
      where: { id: query.termId },
    });

    const [sessions, enrollments] = await this.prisma.$transaction([
      this.prisma.sessions.findMany({
        where: {
          section_id: sectionId,
          session_date: query.date
            ? query.date
            : { gte: term.starts_on, lte: term.ends_on },
        },
        include: { subjects: { select: { name_ar: true } } },
        orderBy: [{ session_date: 'asc' }, { starts_at: 'asc' }],
      }),
      this.prisma.enrollments.findMany({
        where: { section_id: sectionId, status: 'active' },
        include: {
          student: { select: { full_name: true, student_code: true } },
          attendance: {
            where: {
              sessions: {
                session_date: { gte: term.starts_on, lte: term.ends_on },
              },
            },
          },
        },
        orderBy: { student: { full_name: 'asc' } },
      }),
    ]);

    return {
      sectionId,
      sessions: sessions.map((session) => ({
        id: session.id,
        sessionNo: session.session_no,
        sessionDate: toDateOnlyString(session.session_date),
        startsAt: fromTimeValue(session.starts_at),
        subjectNameAr: session.subjects.name_ar,
        sheikhName: session.sheikh_name,
        mode: session.mode,
        status: session.status,
      })),
      rows: enrollments.map((enrollment) => {
        const bySession = new Map(
          enrollment.attendance.map((record) => [record.session_id, record]),
        );
        return {
          enrollmentId: enrollment.id,
          studentName: enrollment.student.full_name,
          studentCode: enrollment.student.student_code,
          defaultAttendanceMode: enrollment.default_attendance_mode,
          absenceCount: enrollment.attendance.filter(
            (record) => record.status === 'absent',
          ).length,
          cells: sessions.map((session) => {
            const record = bySession.get(session.id);
            return {
              sessionId: session.id,
              sessionNo: session.session_no,
              status: record?.status ?? null,
              attendedMode: record?.attended_mode ?? null,
              minutesLate: record?.minutes_late ?? null,
              note: record?.note ?? null,
            };
          }),
        };
      }),
    };
  }

  /**
   * Saves one session's column. Upsert per entry inside a single transaction:
   * `attendance` is UNIQUE (session_id, enrollment_id), so re-saving a
   * corrected column overwrites rather than duplicating, and a dropped
   * connection leaves the column entirely saved or entirely unsaved.
   */
  async saveSession(
    sessionId: string,
    dto: SaveAttendanceDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{ saved: number; warnings: AbsenceWarningSummary[] }> {
    const session = await this.prisma.sessions.findUniqueOrThrow({
      where: { id: sessionId },
      select: { id: true, section_id: true, session_date: true },
    });
    await this.assertSectionAccess(session.section_id, viewer);

    // F2: the section check above is necessary but not sufficient — a teacher
    // legitimately saving their own session's column could otherwise attach
    // rows to enrolments in any section in any branch, which then feed
    // applyAbsencePolicy and can flip another branch's exam eligibility. Reject
    // any enrolment that is not actually active in this session's section.
    const validEnrollmentIds = new Set(
      (
        await this.prisma.enrollments.findMany({
          where: { section_id: session.section_id, status: 'active' },
          select: { id: true },
        })
      ).map((enrollment) => enrollment.id),
    );
    for (const entry of dto.entries) {
      if (!validEnrollmentIds.has(entry.enrollmentId)) {
        throw new BadRequestException(
          'An attendance row refers to an enrolment that is not in this section',
        );
      }
    }

    await this.prisma.$transaction(
      dto.entries.map((entry) =>
        this.prisma.attendance.upsert({
          where: {
            session_id_enrollment_id: {
              session_id: sessionId,
              enrollment_id: entry.enrollmentId,
            },
          },
          create: {
            session_id: sessionId,
            enrollment_id: entry.enrollmentId,
            status: entry.status,
            attended_mode: entry.attendedMode,
            minutes_late: entry.minutesLate,
            note: entry.note,
            recorded_by: actor.userId,
          },
          update: {
            status: entry.status,
            attended_mode: entry.attendedMode,
            minutes_late: entry.minutesLate,
            note: entry.note,
            recorded_by: actor.userId,
            recorded_at: new Date(),
          },
        }),
      ),
    );

    await this.audit.record(actor, {
      action: 'attendance.save',
      entityType: 'session',
      entityId: sessionId,
      after: { entries: dto.entries.length },
    });

    // §4.8: "After each attendance save ... count term absences → at
    // warn_at_absences queue a warning → at max_absences with
    // exceeding_action = 'block_exam', block the exam."
    const warnings = await this.applyAbsencePolicy(
      session.section_id,
      session.session_date,
      dto.entries.map((entry) => entry.enrollmentId),
    );
    return { saved: dto.entries.length, warnings };
  }

  /**
   * Recomputes the absence position of the enrolments just touched and records
   * any newly crossed threshold.
   *
   * `attendance_warnings` is UNIQUE (enrollment, term, threshold), so the
   * insert is what makes this idempotent: "re-runs can never spam a student"
   * (§4.8). The row is created here and left `queued`; the WhatsApp send is a
   * separate concern (Phase 5), which is why no message is sent from an
   * attendance save.
   */
  private async applyAbsencePolicy(
    sectionId: string,
    sessionDate: Date,
    enrollmentIds: string[],
  ): Promise<AbsenceWarningSummary[]> {
    const section = await this.prisma.sections.findUniqueOrThrow({
      where: { id: sectionId },
      select: { academic_year_id: true, level_id: true },
    });
    const term = await this.prisma.terms.findFirst({
      where: {
        academic_year_id: section.academic_year_id,
        starts_on: { lte: sessionDate },
        ends_on: { gte: sessionDate },
      },
    });
    if (!term) {
      // A session outside every term cannot count towards a term's absences.
      return [];
    }

    const policies = await this.prisma.attendance_policies.findMany({
      where: { academic_year_id: section.academic_year_id },
    });
    // §4.8 resolves the level's row, falling back to the year's NULL row —
    // the same precedence as progression rules, so it reuses that resolver.
    const policy = resolveProgressionRules(
      policies.map((row) => ({ levelId: row.level_id, row })),
      section.level_id,
    )?.row;
    if (!policy) {
      return [];
    }

    const counts = await this.prisma.attendance.groupBy({
      by: ['enrollment_id'],
      where: {
        enrollment_id: { in: enrollmentIds },
        status: 'absent',
        sessions: {
          session_date: { gte: term.starts_on, lte: term.ends_on },
        },
      },
      _count: { _all: true },
    });

    const summaries: AbsenceWarningSummary[] = [];
    for (const count of counts) {
      const assessment = assessAbsences(count._count._all, {
        maxAbsences: policy.max_absences,
        warnAtAbsences: policy.warn_at_absences,
        autoWarnEnabled: policy.auto_warn_enabled,
        exceedingAction: policy.exceeding_action,
      });
      if (assessment.warningThreshold === null && !assessment.blocksExams) {
        continue;
      }

      if (assessment.warningThreshold !== null) {
        await this.prisma.attendance_warnings.upsert({
          where: {
            enrollment_id_term_id_threshold: {
              enrollment_id: count.enrollment_id,
              term_id: term.id,
              threshold: assessment.warningThreshold,
            },
          },
          create: {
            enrollment_id: count.enrollment_id,
            term_id: term.id,
            threshold: assessment.warningThreshold,
            absence_count: count._count._all,
          },
          // Already warned at this threshold: leave the original row alone so
          // its created_at still records when the student actually crossed it.
          update: {},
        });
      }

      if (assessment.blocksExams) {
        // §4.6 / §4.8: set is_eligible=false with reason low_attendance on any
        // exam this enrolment is not yet excluded from. The head teacher can
        // override with a reason.
        await this.prisma.exam_eligibility.updateMany({
          where: {
            enrollment_id: count.enrollment_id,
            is_eligible: true,
            overridden_by: null,
          },
          data: {
            is_eligible: false,
            reason_code: 'low_attendance',
            computed_at: new Date(),
          },
        });
      }

      const student = await this.prisma.enrollments.findUnique({
        where: { id: count.enrollment_id },
        select: { student: { select: { full_name: true } } },
      });
      summaries.push({
        enrollmentId: count.enrollment_id,
        studentName: student?.student.full_name ?? '',
        absenceCount: count._count._all,
        threshold: assessment.warningThreshold,
        blocksExams: assessment.blocksExams,
      });
    }
    return summaries;
  }

  private async assertSectionAccess(
    sectionId: string,
    viewer: AuthenticatedUser,
  ): Promise<void> {
    const section = await this.prisma.sections.findUnique({
      where: { id: sectionId },
      select: {
        branch_id: true,
        section_teachers: { select: { user_id: true } },
      },
    });
    if (!section) {
      throw new NotFoundException('Section not found');
    }
    if (!canAccessSection(viewer, section)) {
      // §3: "Record attendance ✅ own sections" for a teacher.
      throw new ForbiddenException('This section is not assigned to you');
    }
  }
}

// Postgres TIME carries no date; the value rides on the Unix epoch in UTC. The
// date-first attendance header shows the period's start time beside its subject.
function fromTimeValue(value: Date): string {
  return value.toISOString().slice(11, 16);
}
