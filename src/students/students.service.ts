import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, students as StudentRecord } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { branchScope } from '../common/branch-scope';
import { resolveWritableBranch } from '../common/access-scope';
import { toDateOnlyString } from '../common/date-only.schema';
import { decryptField, encryptField } from '../common/field-encryption';
import { buildPage, Page, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type {
  CreatePlacementDto,
  CreateStudentDto,
  ListStudentsQueryDto,
  UpdateStudentDto,
} from './dto/student.schema';

export interface StudentView {
  id: string;
  fullName: string;
  gender: string;
  branchId: number | null;
  phone: string | null;
  whatsappPhone: string | null;
  governorateId: number | null;
  markazId: number | null;
  address: string | null;
  birthDate: string | null;
  /** True when a national ID is on file. The value itself is only returned by
   * the dedicated endpoint, so it never rides along in a list response. */
  hasNationalId: boolean;
  status: string;
  /** The student's study year — the level of their enrollment in the current
   * academic year, or null when they are not enrolled this year. Populated by
   * `list`; the single-record reads leave it null. */
  levelId: number | null;
  levelName: string | null;
  whatsappOptIn: boolean;
  notes: string | null;
  /** Absence position in the current term against the level's policy (§4.8).
   *  Populated by `list`; the single reads leave it at the neutral default.
   *  `attendanceRisk`: 'none' below the warn line, 'warning' at/over it, 'over'
   *  at/over the absence limit. */
  absences: number;
  warnAt: number | null;
  maxAbsences: number | null;
  attendanceRisk: AttendanceRisk;
}

export type AttendanceRisk = 'none' | 'warning' | 'over';

/** The current term's date window, for counting a term's absences. */
interface TermWindow {
  startsOn: Date;
  endsOn: Date;
}

/** A student's absence standing for the roster's risk badge. */
interface AbsenceInfo {
  absences: number;
  warnAt: number | null;
  maxAbsences: number | null;
  risk: AttendanceRisk;
}

const NO_ABSENCE_INFO: AbsenceInfo = {
  absences: 0,
  warnAt: null,
  maxAbsences: null,
  risk: 'none',
};

export interface PlacementView {
  id: string;
  studentId: string;
  method: string;
  score: number | null;
  maxScore: number | null;
  passScore: number | null;
  isPassed: boolean | null;
  recommendedBy: string | null;
  placedLevelId: number;
  assessedOn: string;
  notes: string | null;
}

const ENTITY_TYPE = 'student';

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListStudentsQueryDto,
    viewer: AuthenticatedUser,
  ): Promise<Page<StudentView>> {
    // "Study year" is the level of the enrollment in the current academic year
    // (the newest, unless the caller names one). Resolved once here and used
    // both to display each student's level and to scope the levelId filter.
    const yearId = query.academicYearId ?? (await this.currentAcademicYearId());
    // The current term and the year's absence policies drive each row's risk
    // badge (§4.8). Both are small reads resolved once for the whole page.
    const [term, policies] = await Promise.all([
      this.currentTerm(yearId),
      this.absencePolicies(yearId),
    ]);
    const where = this.buildWhere(query, viewer, yearId);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.students.findMany({
        where,
        orderBy: { full_name: 'asc' },
        ...toPrismaPage(query),
        include: currentYearLevelInclude(yearId, term),
      }),
      this.prisma.students.count({ where }),
    ]);
    return buildPage(
      rows.map((row) => toStudent(row, levelOf(row), absenceOf(row, policies))),
      total,
      query,
    );
  }

  /** The ongoing term of the year (today within its window), else the latest. */
  private async currentTerm(yearId: number | null): Promise<TermWindow | null> {
    if (yearId == null) return null;
    const now = new Date();
    const ongoing = await this.prisma.terms.findFirst({
      where: { academic_year_id: yearId, starts_on: { lte: now }, ends_on: { gte: now } },
      select: { starts_on: true, ends_on: true },
    });
    const term =
      ongoing ??
      (await this.prisma.terms.findFirst({
        where: { academic_year_id: yearId },
        orderBy: { term_number: 'desc' },
        select: { starts_on: true, ends_on: true },
      }));
    return term ? { startsOn: term.starts_on, endsOn: term.ends_on } : null;
  }

  /** The year's absence policies (the default plus any per-level overrides). */
  private async absencePolicies(yearId: number | null): Promise<PolicyRow[]> {
    if (yearId == null) return [];
    return this.prisma.attendance_policies.findMany({
      where: { academic_year_id: yearId },
      select: { level_id: true, warn_at_absences: true, max_absences: true },
    });
  }

  /**
   * The newest academic year is "current" — the app's convention everywhere
   * (the calendar reads years hijri-year descending). Null when no year exists
   * yet, in which case no student has a study year to show.
   */
  private async currentAcademicYearId(): Promise<number | null> {
    const year = await this.prisma.academic_years.findFirst({
      orderBy: { hijri_year: 'desc' },
      select: { id: true },
    });
    return year?.id ?? null;
  }

  async getById(id: string, viewer: AuthenticatedUser): Promise<StudentView> {
    return toStudent(await this.findVisible(id, viewer));
  }

  /**
   * Throws NotFound unless the student exists and is inside the viewer's branch
   * scope. The one place that access rule lives, so the record-reading services
   * (attendance, scores, enrollment history) gate on it rather than each
   * re-deriving branch visibility.
   */
  async assertVisible(id: string, viewer: AuthenticatedUser): Promise<void> {
    await this.findVisible(id, viewer);
  }

  /**
   * The national ID is fetched through its own endpoint rather than included
   * in the student record. Reading it is a separate, audited act — spec §9
   * calls a full student export the highest-value action in the system, and
   * this is the highest-value field in it.
   */
  async revealNationalId(
    id: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{ nationalId: string | null }> {
    const student = await this.findVisible(id, viewer);
    await this.audit.record(actor, {
      action: 'student.national_id.read',
      entityType: ENTITY_TYPE,
      entityId: id,
    });
    return {
      nationalId: student.national_id_enc
        ? decryptField(Buffer.from(student.national_id_enc))
        : null,
    };
  }

  async create(
    dto: CreateStudentDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<StudentView> {
    // F4: a branch-bound teacher may only create students inside their own
    // branch; the body's branchId is ignored for them. An institute-wide head
    // teacher may place a student in any branch (or none).
    const branchId = resolveWritableBranch(viewer, dto.branchId);

    const created = await this.prisma.students.create({
      data: {
        full_name: dto.fullName,
        gender: dto.gender,
        branch_id: branchId,
        phone: dto.phone,
        whatsapp_phone: dto.whatsappPhone,
        governorate_id: dto.governorateId,
        markaz_id: dto.markazId,
        address: dto.address,
        birth_date: dto.birthDate,
        national_id_enc: dto.nationalId
          ? new Uint8Array(encryptField(dto.nationalId))
          : null,
        whatsapp_opt_in: dto.whatsappOptIn,
        notes: dto.notes,
        created_by: actor.userId,
      },
    });

    await this.audit.record(actor, {
      action: 'student.create',
      entityType: ENTITY_TYPE,
      entityId: created.id,
      after: toStudent(created),
    });
    return toStudent(created);
  }

  async update(
    id: string,
    dto: UpdateStudentDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<StudentView> {
    const before = await this.findVisible(id, viewer);

    // Declared as one typed object rather than spread inline: a conditional
    // spread produces a union Prisma's XOR input types cannot narrow.
    const data: Prisma.studentsUncheckedUpdateInput = {
      full_name: dto.fullName,
      // F4: only an institute-wide head teacher may move a student between
      // branches. For a branch-bound viewer this is `undefined`, so the column
      // is left untouched and the student cannot be moved out of reach.
      branch_id: viewer.branchId === null ? dto.branchId : undefined,
      phone: dto.phone,
      whatsapp_phone: dto.whatsappPhone,
      governorate_id: dto.governorateId,
      markaz_id: dto.markazId,
      address: dto.address,
      birth_date: dto.birthDate,
      status: dto.status,
      whatsapp_opt_in: dto.whatsappOptIn,
      notes: dto.notes,
      updated_at: new Date(),
    };
    // Omitting the key leaves the column alone; an explicit null clears it.
    if (dto.nationalId !== undefined) {
      data.national_id_enc = dto.nationalId
        ? new Uint8Array(encryptField(dto.nationalId))
        : null;
    }

    const updated = await this.prisma.students.update({ where: { id }, data });

    await this.audit.record(actor, {
      action: 'student.update',
      entityType: ENTITY_TYPE,
      entityId: id,
      before: toStudent(before),
      after: toStudent(updated),
    });
    return toStudent(updated);
  }

  // R9: head teacher only (enforced by @Roles on the route), soft, with reason.
  async softDelete(
    id: string,
    reason: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<void> {
    const before = await this.findVisible(id, viewer);
    await this.prisma.students.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        deleted_by: actor.userId,
        delete_reason: reason,
        status: 'withdrawn',
      },
    });
    await this.audit.record(actor, {
      action: 'student.delete',
      entityType: ENTITY_TYPE,
      entityId: id,
      before: toStudent(before),
      after: { deleteReason: reason },
    });
  }

  async recordPlacement(
    studentId: string,
    dto: CreatePlacementDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<PlacementView> {
    await this.findVisible(studentId, viewer);

    // §4.7: an entrance exam is decided by score vs pass mark; a
    // recommendation has no score to decide with, so isPassed stays null
    // rather than being invented as true.
    const isPassed =
      dto.method === 'entrance_exam' &&
      dto.score !== null &&
      dto.passScore !== null
        ? dto.score >= dto.passScore
        : null;

    const created = await this.prisma.placement_assessments.create({
      data: {
        student_id: studentId,
        method: dto.method,
        score: dto.score,
        max_score: dto.maxScore,
        pass_score: dto.passScore,
        is_passed: isPassed,
        recommended_by: dto.recommendedBy,
        placed_level_id: dto.placedLevelId,
        assessed_on: dto.assessedOn,
        notes: dto.notes,
        created_by: actor.userId,
      },
    });

    await this.audit.record(actor, {
      action: 'student.placement.record',
      entityType: ENTITY_TYPE,
      entityId: studentId,
      after: toPlacement(created),
    });
    return toPlacement(created);
  }

  async listPlacements(
    studentId: string,
    viewer: AuthenticatedUser,
  ): Promise<PlacementView[]> {
    await this.findVisible(studentId, viewer);
    const rows = await this.prisma.placement_assessments.findMany({
      where: { student_id: studentId },
      orderBy: { assessed_on: 'desc' },
    });
    return rows.map(toPlacement);
  }

  private buildWhere(
    query: ListStudentsQueryDto,
    viewer: AuthenticatedUser,
    yearId: number | null,
  ): Prisma.studentsWhereInput {
    return {
      deleted_at: null,
      ...branchScope(viewer.branchId),
      ...(query.gender ? { gender: query.gender } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.branchId ? { branch_id: query.branchId } : {}),
      ...(query.markazId ? { markaz_id: query.markazId } : {}),
      ...(query.missingPhone
        ? { AND: [{ phone: null }, { whatsapp_phone: null }] }
        : {}),
      // students.full_name carries a GIN trigram index, so `contains` is an
      // index scan rather than a sequential one even at full roster size.
      ...(query.search ? { full_name: { contains: query.search } } : {}),
      // Study-year filter: only students enrolled at this level in the current
      // year. Needs a year to resolve against, so it is inert without one.
      ...(query.levelId && yearId !== null
        ? {
            enrollments_enrollments_student_idTostudents: {
              some: {
                academic_year_id: yearId,
                section: { level_id: query.levelId },
              },
            },
          }
        : {}),
    };
  }

  private async findVisible(
    id: string,
    viewer: AuthenticatedUser,
  ): Promise<StudentRecord> {
    const student = await this.prisma.students.findUnique({ where: { id } });
    if (!student || student.deleted_at) {
      throw new NotFoundException('Student not found');
    }
    if (viewer.branchId !== null && student.branch_id !== viewer.branchId) {
      throw new NotFoundException('Student not found');
    }
    return student;
  }
}

/** The student's current-year level, when the row was loaded with the join. */
interface EnrolledLevel {
  id: number;
  name_ar: string;
}

/**
 * Joins each student to their enrollment in the given year and that section's
 * level. A student has at most one enrollment per year (enrollments is UNIQUE
 * on (student, year)), so `take: 1` is the whole story. A null year (none
 * exists yet) is filtered to id 0, which matches nothing, so every level is
 * null rather than the join being dropped and the row type shifting.
 */
function currentYearLevelInclude(yearId: number | null, term: TermWindow | null) {
  // With no term there is nothing to count against, so the attendance filter is
  // an empty window (matches nothing) rather than the join being dropped.
  const absentInTerm: Prisma.attendanceWhereInput = {
    status: 'absent',
    sessions: term
      ? { session_date: { gte: term.startsOn, lte: term.endsOn } }
      : { session_date: { gte: new Date(0), lt: new Date(0) } },
  };
  return {
    enrollments_enrollments_student_idTostudents: {
      where: { academic_year_id: yearId ?? 0 },
      orderBy: { created_at: 'desc' as const },
      take: 1,
      select: {
        section: {
          select: { level_id: true, levels: { select: { id: true, name_ar: true } } },
        },
        attendance: { where: absentInTerm, select: { id: true } },
      },
    },
  } satisfies Prisma.studentsInclude;
}

type StudentWithLevel = Prisma.studentsGetPayload<{
  include: ReturnType<typeof currentYearLevelInclude>;
}>;

interface PolicyRow {
  level_id: number | null;
  warn_at_absences: number;
  max_absences: number;
}

function levelOf(row: StudentWithLevel): EnrolledLevel | null {
  return (
    row.enrollments_enrollments_student_idTostudents[0]?.section.levels ?? null
  );
}

/** The student's term absences against the policy for their level (the per-level
 *  override if one exists, else the year default). Null policy → no risk shown. */
function absenceOf(row: StudentWithLevel, policies: PolicyRow[]): AbsenceInfo {
  const enrollment = row.enrollments_enrollments_student_idTostudents[0];
  if (!enrollment) return NO_ABSENCE_INFO;
  const absences = enrollment.attendance.length;
  const levelId = enrollment.section.level_id;
  const policy =
    policies.find((p) => p.level_id === levelId) ??
    policies.find((p) => p.level_id === null) ??
    null;
  if (!policy) return { absences, warnAt: null, maxAbsences: null, risk: 'none' };
  const risk: AttendanceRisk =
    absences >= policy.max_absences
      ? 'over'
      : absences >= policy.warn_at_absences
        ? 'warning'
        : 'none';
  return {
    absences,
    warnAt: policy.warn_at_absences,
    maxAbsences: policy.max_absences,
    risk,
  };
}

function toStudent(
  row: StudentRecord,
  level: EnrolledLevel | null = null,
  absence: AbsenceInfo = NO_ABSENCE_INFO,
): StudentView {
  return {
    id: row.id,
    fullName: row.full_name,
    gender: row.gender,
    branchId: row.branch_id,
    phone: row.phone,
    whatsappPhone: row.whatsapp_phone,
    governorateId: row.governorate_id,
    markazId: row.markaz_id,
    address: row.address,
    birthDate: row.birth_date && toDateOnlyString(row.birth_date),
    hasNationalId: row.national_id_enc !== null,
    status: row.status,
    levelId: level?.id ?? null,
    levelName: level?.name_ar ?? null,
    whatsappOptIn: row.whatsapp_opt_in,
    notes: row.notes,
    absences: absence.absences,
    warnAt: absence.warnAt,
    maxAbsences: absence.maxAbsences,
    attendanceRisk: absence.risk,
  };
}

function toPlacement(row: {
  id: string;
  student_id: string;
  method: string;
  score: Prisma.Decimal | null;
  max_score: Prisma.Decimal | null;
  pass_score: Prisma.Decimal | null;
  is_passed: boolean | null;
  recommended_by: string | null;
  placed_level_id: number;
  assessed_on: Date;
  notes: string | null;
}): PlacementView {
  return {
    id: row.id,
    studentId: row.student_id,
    method: row.method,
    score: row.score?.toNumber() ?? null,
    maxScore: row.max_score?.toNumber() ?? null,
    passScore: row.pass_score?.toNumber() ?? null,
    isPassed: row.is_passed,
    recommendedBy: row.recommended_by,
    placedLevelId: row.placed_level_id,
    assessedOn: toDateOnlyString(row.assessed_on),
    notes: row.notes,
  };
}
