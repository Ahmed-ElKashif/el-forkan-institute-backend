import { Injectable, NotFoundException } from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { sectionScope } from '../common/access-scope';
import { buildRosterWorkbook } from '../excel/roster-writer';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * §6.5 — export mirrors the layout the institute already prints.
 *
 * Spec §9: "Log every export with actor and row count; a full student export
 * is the highest-value action in the system." That audit write is not optional
 * bookkeeping — it is the only record that a copy of the roster left the
 * building.
 */

const ROSTER_HEADERS = ['م', 'الأسم', 'المركز', 'رقم الهاتف'] as const;
const RESULT_HEADERS = ['م', 'الأسم', 'النتيجة', 'المواد المتبقية'] as const;

const DECISION_LABELS: Record<string, string> = {
  promote: 'إجتاز المستوى',
  promote_with_carry: 'إجتاز المستوى بمواد',
  repeat: 'لم يجتاز المستوى',
  makeup_required: 'مطلوب امتحان دور ثان',
  graduate: 'تخرج',
  withdrawn: 'منسحب',
};

const GENDER_SHEET_NAMES: Record<string, string> = {
  male: 'إخوة',
  female: 'أخوات',
};

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  rowCount: number;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async exportRoster(
    academicYearId: number,
    levelId: number | undefined,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<ExportResult> {
    const { sections, year } = await this.loadScope(
      academicYearId,
      levelId,
      viewer,
    );

    // R3: "Every roster is produced separately per gender" — one sheet each,
    // which is also what makes the file re-importable.
    const sheets = ['male', 'female'].map((gender) => {
      const rows = sections
        .filter((section) => section.gender === gender)
        .flatMap((section) => section.enrollments)
        .map((enrollment, index) => [
          String(index + 1),
          enrollment.student.full_name,
          enrollment.student.markazes?.name_ar ?? '',
          enrollment.student.whatsapp_phone ?? enrollment.student.phone ?? '',
        ]);
      return {
        name: GENDER_SHEET_NAMES[gender],
        headers: [...ROSTER_HEADERS],
        rows,
      };
    });

    return this.finish(
      sheets,
      year,
      `roster-${year.hijri_year}${levelId ? `-level-${levelId}` : ''}.xlsx`,
      'roster',
      actor,
    );
  }

  async exportResults(
    academicYearId: number,
    levelId: number | undefined,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<ExportResult> {
    const { sections, year } = await this.loadScope(
      academicYearId,
      levelId,
      viewer,
    );

    const sheets = ['male', 'female'].map((gender) => {
      const rows = sections
        .filter((section) => section.gender === gender)
        .flatMap((section) => section.enrollments)
        .map((enrollment, index) => [
          String(index + 1),
          enrollment.student.full_name,
          enrollment.final_decision
            ? (DECISION_LABELS[enrollment.final_decision] ??
              enrollment.final_decision)
            : '',
          enrollment.carried_subjects_carried_subjects_enrollment_idToenrollments
            .filter((carry) => carry.status === 'pending')
            .map((carry) => carry.subjects.name_ar)
            .join(' / '),
        ]);
      return {
        name: GENDER_SHEET_NAMES[gender],
        headers: [...RESULT_HEADERS],
        rows,
      };
    });

    return this.finish(
      sheets,
      year,
      `results-${year.hijri_year}${levelId ? `-level-${levelId}` : ''}.xlsx`,
      'results',
      actor,
    );
  }

  /**
   * One query for the whole file. A roster export walks sections → enrolments
   * → student → markaz → carries; fetching those per row would be four
   * round-trips per student.
   */
  private async loadScope(
    academicYearId: number,
    levelId: number | undefined,
    viewer: AuthenticatedUser,
  ) {
    const year = await this.prisma.academic_years.findUniqueOrThrow({
      where: { id: academicYearId },
    });
    const sections = await this.prisma.sections.findMany({
      where: {
        // Scoped like every other read: a teacher exports their own sections
        // only (spec §3, "Export / print rosters ✅ own").
        ...sectionScope(viewer),
        academic_year_id: academicYearId,
        ...(levelId ? { level_id: levelId } : {}),
      },
      orderBy: [{ level_id: 'asc' }, { name: 'asc' }],
      include: {
        enrollments: {
          where: { status: { not: 'withdrawn' } },
          orderBy: { student: { full_name: 'asc' } },
          include: {
            student: {
              select: {
                full_name: true,
                phone: true,
                whatsapp_phone: true,
                markazes: { select: { name_ar: true } },
              },
            },
            carried_subjects_carried_subjects_enrollment_idToenrollments: {
              include: { subjects: { select: { name_ar: true } } },
            },
          },
        },
      },
    });

    if (sections.length === 0) {
      throw new NotFoundException(
        'No sections to export for this year and level',
      );
    }
    return { sections, year };
  }

  private async finish(
    sheets: Array<{ name: string; headers: string[]; rows: string[][] }>,
    year: { hijri_year: number },
    filename: string,
    kind: string,
    actor: Actor,
  ): Promise<ExportResult> {
    const settings = await this.prisma.institute_settings.findUniqueOrThrow({
      where: { id: 1 },
    });
    const branch = await this.prisma.branches.findFirst({
      orderBy: { id: 'asc' },
      select: { name_ar: true },
    });

    const rowCount = sheets.reduce(
      (total, sheet) => total + sheet.rows.length,
      0,
    );
    const buffer = await buildRosterWorkbook({
      instituteName: settings.name_ar,
      branchName: branch?.name_ar ?? '',
      title: `${new Date().getUTCFullYear()} / ${year.hijri_year}`,
      sheets,
    });

    await this.audit.record(actor, {
      action: `export.${kind}`,
      entityType: 'export',
      entityId: filename,
      after: { rowCount, filename },
    });

    return { buffer, filename, rowCount };
  }
}
