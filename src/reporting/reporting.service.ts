import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { enrollmentScope, sectionScope } from '../common/access-scope';
import { toDateOnlyString } from '../common/date-only.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * §8 Phase 6 — "Dashboards (headcount by level/gender/markaz, attendance
 * trends, pass rates)".
 *
 * Every figure here is a SQL aggregate. The alternative — loading rows and
 * counting in JavaScript — would pull the entire student body over the wire to
 * render a number, on a page that exists to be glanced at.
 *
 * Everything is scoped like every other read (spec §9): a teacher's dashboard
 * shows their own sections, the head teacher's shows the branch or the
 * institute.
 */

export interface HeadcountCell {
  levelId: number;
  levelCode: string;
  levelNameAr: string;
  male: number;
  female: number;
  total: number;
}

export interface MarkazCount {
  markazId: number | null;
  markazNameAr: string;
  count: number;
}

export interface AttendancePoint {
  sessionDate: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  attendanceRate: number;
}

export interface PassRateRow {
  levelId: number;
  levelCode: string;
  subjectId: number;
  subjectNameAr: string;
  sat: number;
  passed: number;
  failed: number;
  absent: number;
  passRate: number;
}

export interface DashboardSummary {
  academicYearId: number;
  hijriYear: number;
  students: { active: number; withPhone: number; phoneCoverage: number };
  enrollments: number;
  sections: number;
  pendingCarries: number;
  certificatesIssued: number;
}

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    academicYearId: number,
    viewer: AuthenticatedUser,
  ): Promise<DashboardSummary> {
    const year = await this.prisma.academic_years.findUniqueOrThrow({
      where: { id: academicYearId },
      select: { hijri_year: true },
    });
    const scope = enrollmentScope(viewer);
    const where: Prisma.enrollmentsWhereInput = {
      ...scope,
      academic_year_id: academicYearId,
      status: 'active',
    };

    const [enrollments, withPhone, sections, pendingCarries, certificates] =
      await this.prisma.$transaction([
        this.prisma.enrollments.count({ where }),
        this.prisma.enrollments.count({
          where: {
            ...where,
            student: {
              OR: [{ phone: { not: null } }, { whatsapp_phone: { not: null } }],
            },
          },
        }),
        this.prisma.sections.count({
          where: { ...sectionScope(viewer), academic_year_id: academicYearId },
        }),
        this.prisma.carried_subjects.count({
          where: {
            status: 'pending',
            enrollments_carried_subjects_enrollment_idToenrollments: where,
          },
        }),
        this.prisma.certificates.count({
          where: { academic_year_id: academicYearId, revoked_at: null },
        }),
      ]);

    return {
      academicYearId,
      hijriYear: year.hijri_year,
      students: {
        active: enrollments,
        withPhone,
        phoneCoverage:
          enrollments === 0 ? 0 : Math.round((withPhone / enrollments) * 100),
      },
      enrollments,
      sections,
      pendingCarries,
      certificatesIssued: certificates,
    };
  }

  /**
   * Headcount by level × gender. R3 keeps the two genders on separate rosters,
   * so the institute reads them side by side rather than as one total.
   */
  async headcountByLevel(
    academicYearId: number,
    viewer: AuthenticatedUser,
  ): Promise<HeadcountCell[]> {
    const levels = await this.prisma.levels.findMany({
      orderBy: { sort_order: 'asc' },
    });

    // One grouped aggregate for the whole grid, then pivoted in memory over
    // at most twelve rows (six levels × two genders).
    const grouped = await this.prisma.enrollments.groupBy({
      by: ['gender', 'section_id'],
      where: {
        ...enrollmentScope(viewer),
        academic_year_id: academicYearId,
        status: 'active',
      },
      _count: { _all: true },
    });
    const sections = await this.prisma.sections.findMany({
      where: { academic_year_id: academicYearId },
      select: { id: true, level_id: true },
    });
    const levelBySection = new Map(
      sections.map((section) => [section.id, section.level_id]),
    );

    return levels.map((level) => {
      const forLevel = grouped.filter(
        (row) => levelBySection.get(row.section_id) === level.id,
      );
      const male = sumWhere(forLevel, 'male');
      const female = sumWhere(forLevel, 'female');
      return {
        levelId: level.id,
        levelCode: level.code,
        levelNameAr: level.name_ar,
        male,
        female,
        total: male + female,
      };
    });
  }

  /** Where the students come from — the المركز column of the printed roster. */
  async headcountByMarkaz(
    academicYearId: number,
    viewer: AuthenticatedUser,
  ): Promise<MarkazCount[]> {
    const grouped = await this.prisma.students.groupBy({
      by: ['markaz_id'],
      where: {
        deleted_at: null,
        enrollments_enrollments_student_idTostudents: {
          some: {
            ...enrollmentScope(viewer),
            academic_year_id: academicYearId,
            status: 'active',
          },
        },
      },
      // _all, not markaz_id: counting the COLUMN counts non-null values, so
      // the "no markaz recorded" group — the biggest one right after the
      // historical import (§6.4) — would report zero.
      _count: { _all: true },
    });

    const markazes = await this.prisma.markazes.findMany({
      where: {
        id: {
          in: grouped
            .map((row) => row.markaz_id)
            .filter((id): id is number => id !== null),
        },
      },
      select: { id: true, name_ar: true },
    });
    const nameById = new Map(
      markazes.map((markaz) => [markaz.id, markaz.name_ar]),
    );

    // Sorted here rather than in SQL: Prisma's orderBy._count only accepts a
    // scalar column, and ordering by markaz_id would order by the broken
    // non-null count above.
    return grouped
      .map((row) => ({
        markazId: row.markaz_id,
        // §6.4: after the historical import "phone/markaz mostly empty —
        // expected", so the unknown bucket is a real and useful figure.
        markazNameAr:
          row.markaz_id === null
            ? 'غير محدد'
            : (nameById.get(row.markaz_id) ?? 'غير معروف'),
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** Attendance per session date, for a term — the trend line. */
  async attendanceTrend(
    termId: number,
    viewer: AuthenticatedUser,
  ): Promise<AttendancePoint[]> {
    const term = await this.prisma.terms.findUniqueOrThrow({
      where: { id: termId },
    });

    const sessions = await this.prisma.sessions.findMany({
      where: {
        sections: sectionScope(viewer),
        session_date: { gte: term.starts_on, lte: term.ends_on },
      },
      select: { id: true, session_date: true },
      orderBy: { session_date: 'asc' },
    });
    if (sessions.length === 0) {
      return [];
    }

    const grouped = await this.prisma.attendance.groupBy({
      by: ['session_id', 'status'],
      where: { session_id: { in: sessions.map((session) => session.id) } },
      _count: { _all: true },
    });

    const dateBySession = new Map(
      sessions.map((session) => [
        session.id,
        toDateOnlyString(session.session_date),
      ]),
    );
    const byDate = new Map<string, AttendancePoint>();
    for (const row of grouped) {
      const date = dateBySession.get(row.session_id);
      if (!date) continue;
      const point = byDate.get(date) ?? {
        sessionDate: date,
        present: 0,
        absent: 0,
        late: 0,
        excused: 0,
        attendanceRate: 0,
      };
      point[row.status] += row._count._all;
      byDate.set(date, point);
    }

    return [...byDate.values()]
      .map((point) => {
        const recorded =
          point.present + point.absent + point.late + point.excused;
        return {
          ...point,
          // Late and excused count as attended: the student was accounted for.
          // Only a plain absence is a miss.
          attendanceRate:
            recorded === 0
              ? 0
              : Math.round(((recorded - point.absent) / recorded) * 100),
        };
      })
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  }

  /**
   * Pass rate per examined subject. Counted at the leaf (R14), because that is
   * what an `exam_results` row is — one per examinable curriculum row.
   */
  async passRates(
    academicYearId: number,
    viewer: AuthenticatedUser,
  ): Promise<PassRateRow[]> {
    const results = await this.prisma.exam_results.findMany({
      where: {
        enrollments: {
          ...enrollmentScope(viewer),
          academic_year_id: academicYearId,
        },
        result: { not: 'pending' },
      },
      select: {
        result: true,
        exams: {
          select: {
            curriculum: {
              select: {
                level_id: true,
                subject_id: true,
                subjects: { select: { name_ar: true } },
                levels: { select: { code: true } },
              },
            },
          },
        },
      },
    });

    const byKey = new Map<string, PassRateRow>();
    for (const row of results) {
      const curriculum = row.exams.curriculum;
      const key = `${curriculum.level_id}:${curriculum.subject_id}`;
      const entry = byKey.get(key) ?? {
        levelId: curriculum.level_id,
        levelCode: curriculum.levels.code,
        subjectId: curriculum.subject_id,
        subjectNameAr: curriculum.subjects.name_ar,
        sat: 0,
        passed: 0,
        failed: 0,
        absent: 0,
        passRate: 0,
      };
      entry.sat += 1;
      if (row.result === 'pass') entry.passed += 1;
      else if (row.result === 'fail') entry.failed += 1;
      else entry.absent += 1;
      byKey.set(key, entry);
    }

    return [...byKey.values()]
      .map((entry) => ({
        ...entry,
        // An absence is not a pass, and it is not excluded either: a student
        // who did not sit has not passed the subject.
        passRate:
          entry.sat === 0 ? 0 : Math.round((entry.passed / entry.sat) * 100),
      }))
      .sort(
        (a, b) =>
          a.levelId - b.levelId ||
          a.subjectNameAr.localeCompare(b.subjectNameAr),
      );
  }
}

function sumWhere(
  rows: Array<{ gender: string; _count: { _all: number } }>,
  gender: string,
): number {
  return rows
    .filter((row) => row.gender === gender)
    .reduce((total, row) => total + row._count._all, 0);
}
