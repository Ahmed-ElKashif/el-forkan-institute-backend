import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toDateOnlyString } from '../common/date-only.schema';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { StudentsService } from './students.service';

/** One academic year the student was enrolled in — the section, its level, and
 *  how the year ended up (status/entry). The spine of the profile timeline. */
export interface EnrollmentHistoryView {
  id: string;
  academicYearId: number;
  hijriYear: number | null;
  status: string;
  entryType: string;
  isHistorical: boolean;
  sectionId: string;
  sectionName: string;
  levelId: number | null;
  levelName: string | null;
}

/** A single attended (or missed) session, most recent first. */
export interface AttendanceRecordView {
  sessionDate: string;
  mode: string;
  sectionName: string;
  subjectName: string;
  status: string;
  attendedMode: string | null;
  minutesLate: number | null;
}

/** Attendance rolled up across every enrollment: the four status tallies plus a
 *  window of the most recent sessions. */
export interface AttendanceSummaryView {
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  recent: AttendanceRecordView[];
  /** The current-term absence standing against the level's policy (§4.8), or
   *  null when the student is not enrolled this year / no policy is set. Drives
   *  the profile's absence banner and the "warn" action. */
  position: AbsencePositionView | null;
}

export interface AbsencePositionView {
  absences: number;
  warnAt: number;
  maxAbsences: number;
  risk: 'none' | 'warning' | 'over';
  /** When an absence warning was last sent for this term, or null if none. */
  warningSentAt: string | null;
}

/** One exam result — the subject and term it belongs to, the score against the
 *  subject maximum, and the pass/fail/absent verdict. */
export interface ExamResultView {
  id: string;
  subjectName: string;
  termNumber: number;
  examType: string;
  score: number | null;
  maxScore: number;
  passScore: number;
  isAbsent: boolean;
  result: string;
}

/** How many recent sessions the attendance panel shows. */
const RECENT_ATTENDANCE_WINDOW = 20;

/**
 * Read-only, per-student record aggregation for the profile page. Attendance
 * and exam results are stored against an *enrollment*, not the student, so
 * every query here reaches them through the student's enrollments with a
 * relation filter. Kept out of `StudentsService` (registration + editing) so
 * that class stays about the student record itself.
 */
@Injectable()
export class StudentRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  async enrollmentHistory(
    studentId: string,
    viewer: AuthenticatedUser,
  ): Promise<EnrollmentHistoryView[]> {
    await this.students.assertVisible(studentId, viewer);

    const rows = await this.prisma.enrollments.findMany({
      where: { student_id: studentId },
      orderBy: { academic_year_id: 'desc' },
      select: {
        id: true,
        academic_year_id: true,
        status: true,
        entry_type: true,
        is_historical: true,
        section: {
          select: {
            id: true,
            name: true,
            levels: { select: { id: true, name_ar: true } },
          },
        },
      },
    });

    // enrollments carries no relation to academic_years, so the hijri year is
    // resolved in one lookup over the (tiny) years table rather than N joins.
    const hijriByYear = await this.hijriByYear(
      rows.map((row) => row.academic_year_id),
    );

    return rows.map((row) => ({
      id: row.id,
      academicYearId: row.academic_year_id,
      hijriYear: hijriByYear.get(row.academic_year_id) ?? null,
      status: row.status,
      entryType: row.entry_type,
      isHistorical: row.is_historical,
      sectionId: row.section.id,
      sectionName: row.section.name,
      levelId: row.section.levels?.id ?? null,
      levelName: row.section.levels?.name_ar ?? null,
    }));
  }

  async attendanceSummary(
    studentId: string,
    viewer: AuthenticatedUser,
  ): Promise<AttendanceSummaryView> {
    await this.students.assertVisible(studentId, viewer);

    const of = (status: Prisma.attendanceWhereInput['status']) => ({
      enrollments: { student_id: studentId },
      status,
    });

    // Four counts rather than a groupBy: `count()` returns a plain number,
    // whereas groupBy's `_count` types as a stubborn union that will not narrow.
    // All four hit the (enrollment_id, status) index, so this is cheap.
    const [present, absent, late, excused, recent] = await this.prisma.$transaction([
      this.prisma.attendance.count({ where: of('present') }),
      this.prisma.attendance.count({ where: of('absent') }),
      this.prisma.attendance.count({ where: of('late') }),
      this.prisma.attendance.count({ where: of('excused') }),
      this.prisma.attendance.findMany({
        where: { enrollments: { student_id: studentId } },
        orderBy: { sessions: { session_date: 'desc' } },
        take: RECENT_ATTENDANCE_WINDOW,
        select: {
          status: true,
          attended_mode: true,
          minutes_late: true,
          sessions: {
            select: {
              session_date: true,
              mode: true,
              sections: { select: { name: true } },
              subjects: { select: { name_ar: true } },
            },
          },
        },
      }),
    ]);

    return {
      present,
      absent,
      late,
      excused,
      total: present + absent + late + excused,
      recent: recent.map((row) => ({
        sessionDate: toDateOnlyString(row.sessions.session_date),
        mode: row.sessions.mode,
        sectionName: row.sessions.sections.name,
        subjectName: row.sessions.subjects.name_ar,
        status: row.status,
        attendedMode: row.attended_mode,
        minutesLate: row.minutes_late,
      })),
      position: await this.absencePosition(studentId),
    };
  }

  /**
   * The student's current-term absence standing (§4.8): how many absences this
   * term, the level's warn/limit thresholds, the derived risk, and when a
   * warning was last sent. Null when there is no current enrollment/term/policy.
   */
  private async absencePosition(studentId: string): Promise<AbsencePositionView | null> {
    const enrollment = await this.prisma.enrollments.findFirst({
      where: { student_id: studentId },
      orderBy: { academic_year_id: 'desc' },
      select: { id: true, academic_year_id: true, section: { select: { level_id: true } } },
    });
    if (!enrollment) return null;

    const now = new Date();
    const term =
      (await this.prisma.terms.findFirst({
        where: {
          academic_year_id: enrollment.academic_year_id,
          starts_on: { lte: now },
          ends_on: { gte: now },
        },
        select: { id: true, starts_on: true, ends_on: true },
      })) ??
      (await this.prisma.terms.findFirst({
        where: { academic_year_id: enrollment.academic_year_id },
        orderBy: { term_number: 'desc' },
        select: { id: true, starts_on: true, ends_on: true },
      }));
    if (!term) return null;

    const policies = await this.prisma.attendance_policies.findMany({
      where: { academic_year_id: enrollment.academic_year_id },
      select: { level_id: true, warn_at_absences: true, max_absences: true },
    });
    const policy =
      policies.find((p) => p.level_id === enrollment.section.level_id) ??
      policies.find((p) => p.level_id === null);
    if (!policy) return null;

    const [absences, warning] = await Promise.all([
      this.prisma.attendance.count({
        where: {
          enrollment_id: enrollment.id,
          status: 'absent',
          sessions: { session_date: { gte: term.starts_on, lte: term.ends_on } },
        },
      }),
      this.prisma.attendance_warnings.findFirst({
        where: { enrollment_id: enrollment.id, term_id: term.id, message_id: { not: null } },
        orderBy: { created_at: 'desc' },
        select: { created_at: true },
      }),
    ]);

    const risk: 'none' | 'warning' | 'over' =
      absences >= policy.max_absences ? 'over' : absences >= policy.warn_at_absences ? 'warning' : 'none';

    return {
      absences,
      warnAt: policy.warn_at_absences,
      maxAbsences: policy.max_absences,
      risk,
      warningSentAt: warning ? warning.created_at.toISOString() : null,
    };
  }

  async examResults(
    studentId: string,
    viewer: AuthenticatedUser,
  ): Promise<ExamResultView[]> {
    await this.students.assertVisible(studentId, viewer);

    const rows = await this.prisma.exam_results.findMany({
      where: { enrollments: { student_id: studentId } },
      orderBy: { entered_at: 'desc' },
      select: {
        id: true,
        score: true,
        is_absent: true,
        result: true,
        exams: {
          select: {
            exam_type: true,
            curriculum: {
              select: {
                term_number: true,
                max_score: true,
                pass_score: true,
                subjects: { select: { name_ar: true } },
              },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      subjectName: row.exams.curriculum.subjects.name_ar,
      termNumber: row.exams.curriculum.term_number,
      examType: row.exams.exam_type,
      score: row.score?.toNumber() ?? null,
      maxScore: row.exams.curriculum.max_score.toNumber(),
      passScore: row.exams.curriculum.pass_score.toNumber(),
      isAbsent: row.is_absent,
      result: row.result,
    }));
  }

  /** Maps the given academic-year ids to their hijri year in one query. */
  private async hijriByYear(ids: number[]): Promise<Map<number, number>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const years = await this.prisma.academic_years.findMany({
      where: { id: { in: unique } },
      select: { id: true, hijri_year: true },
    });
    return new Map(years.map((y) => [y.id, y.hijri_year]));
  }
}
