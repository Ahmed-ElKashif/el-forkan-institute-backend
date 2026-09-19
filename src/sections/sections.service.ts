import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import {
  canAccessSection,
  enrollmentScope,
  sectionScope,
} from '../common/access-scope';
import { AuditService } from '../common/audit.service';
import { buildPage, Page, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type {
  AssignTeacherDto,
  CreateEnrollmentDto,
  TransferEnrollmentDto,
  CreateSectionDto,
  ListEnrollmentsQueryDto,
  ListSectionsQueryDto,
  UpdateEnrollmentDto,
  UpdateSectionDto,
} from './dto/section.schema';

/* إخوة / أخوات — the wording the institute's roster sheets use and the sheet
   names the Excel import and export read (R3). Kept identical to the seeder's
   so a provisioned year and a seeded one name their classes the same way. */
const GENDER_SUFFIXES = [
  { gender: 'male', suffix: 'إخوة' },
  { gender: 'female', suffix: 'أخوات' },
] as const;

/**
 * Rethrows a unique violation on the class key as a 409 the head teacher can
 * act on, rather than a raw constraint name. A level has many subjects but a
 * single cohort (R1 × R3), so a second class for the same level and gender is
 * a mistake, not a capacity decision.
 *
 * Returns `never`, so `.catch(refuseSecondClass)` leaves the promise's resolved
 * type intact instead of widening it.
 */
function refuseSecondClass(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(
      'This level already has a class for that gender in this year and branch; a level has one class, not several',
    );
  }
  throw error;
}

export interface SectionTeacherView {
  userId: string;
  fullName: string;
  isPrimary: boolean;
}

export interface SectionView {
  id: string;
  branchId: number;
  academicYearId: number;
  levelId: number;
  gender: string;
  name: string;
  defaultMode: string;
  supervisorId: string | null;
  whatsappGroupId: string | null;
  capacity: number | null;
  enrolledCount: number;
  teachers: SectionTeacherView[];
}

export interface EnrollmentView {
  id: string;
  studentId: string;
  studentName: string;
  sectionId: string;
  academicYearId: number;
  branchId: number;
  gender: string;
  entryType: string;
  status: string;
  defaultAttendanceMode: string;
  finalDecision: string | null;
  isHistorical: boolean;
  /** Subjects this enrolment still owes from an earlier level (R13/R14), still
   *  pending. Lets the roster flag "carries a subject from a previous level"
   *  without a per-row query; the detail lives on the student profile. */
  pendingCarryCount: number;
}

export interface PhoneCoverage {
  total: number;
  withPhone: number;
  percentage: number;
}

const SECTION_SHAPE = {
  include: {
    section_teachers: {
      include: { user: { select: { full_name: true } } },
    },
    /* Active enrolments only. A `completed` one was promoted out of this class
       and a `withdrawn` one has left, so counting every row ever created told
       the roster it held students it does not list — the roster reads active
       members, and a class that graduated its intake reported a full register
       over an empty table. */
    _count: { select: { enrollments: { where: { status: 'active' } } } },
  },
} satisfies Prisma.sectionsDefaultArgs;

type SectionRecord = Prisma.sectionsGetPayload<typeof SECTION_SHAPE>;

const ENROLLMENT_SHAPE = {
  include: {
    student: { select: { full_name: true } },
  },
} satisfies Prisma.enrollmentsDefaultArgs;

type EnrollmentRecord = Prisma.enrollmentsGetPayload<typeof ENROLLMENT_SHAPE>;

@Injectable()
export class SectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListSectionsQueryDto,
    viewer: AuthenticatedUser,
  ): Promise<Page<SectionView>> {
    const where: Prisma.sectionsWhereInput = {
      ...sectionScope(viewer),
      ...(query.academicYearId
        ? { academic_year_id: query.academicYearId }
        : {}),
      ...(query.levelId ? { level_id: query.levelId } : {}),
      ...(query.gender ? { gender: query.gender } : {}),
      ...(query.branchId ? { branch_id: query.branchId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.sections.findMany({
        where,
        ...SECTION_SHAPE,
        orderBy: [{ level_id: 'asc' }, { gender: 'asc' }, { name: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.sections.count({ where }),
    ]);
    return buildPage(rows.map(toSection), total, query);
  }

  async getById(id: string, viewer: AuthenticatedUser): Promise<SectionView> {
    return toSection(await this.findAccessible(id, viewer));
  }

  /**
   * Creates the year's classes: one per level per gender, and no more.
   *
   * The institute runs university-style — a level has many subjects but a
   * single cohort (R1 × R3), so the class list is not something anyone should
   * be typing in by hand. Subjects reach students through `curriculum`
   * (year, level, term), never through the class, which is why one class per
   * level is enough to teach every subject that level offers.
   *
   * Idempotent by identity, not by name: re-running fills the gaps and leaves
   * an existing class's name, capacity and supervisor exactly as they are. That
   * matters because the head teacher may have renamed a class, and provisioning
   * a new year must never quietly undo that.
   */
  async provisionYear(
    academicYearId: number,
    branchId: number,
    actor: Actor,
  ): Promise<{ created: number; total: number }> {
    const levels = await this.prisma.levels.findMany({
      orderBy: { sort_order: 'asc' },
      select: { id: true, name_ar: true },
    });

    let created = 0;
    for (const level of levels) {
      for (const { gender, suffix } of GENDER_SUFFIXES) {
        const exists = await this.prisma.sections.findFirst({
          where: {
            branch_id: branchId,
            academic_year_id: academicYearId,
            level_id: level.id,
            gender,
          },
          select: { id: true },
        });
        if (exists) continue;
        try {
          await this.prisma.sections.create({
            data: {
              branch_id: branchId,
              academic_year_id: academicYearId,
              level_id: level.id,
              gender,
              name: `${level.name_ar} — ${suffix}`,
            },
          });
          created += 1;
        } catch (cause) {
          // P2002 means another provision run won the race and made this exact
          // class. That is the outcome we wanted, so it is not an error.
          if (
            !(cause instanceof Prisma.PrismaClientKnownRequestError) ||
            cause.code !== 'P2002'
          ) {
            throw cause;
          }
        }
      }
    }

    await this.audit.record(actor, {
      action: 'section.provision',
      entityType: 'academic_year',
      entityId: String(academicYearId),
      after: {
        branchId,
        created,
        total: levels.length * GENDER_SUFFIXES.length,
      },
    });
    return { created, total: levels.length * GENDER_SUFFIXES.length };
  }

  /**
   * Creates one class directly. Kept for the import's recovery path, which has
   * to be able to name a class it could not find — but a level+gender already
   * holds exactly one class (see {@link provisionYear}), so the ordinary answer
   * to "I need a class" is to provision the year, not to call this.
   */
  async create(dto: CreateSectionDto, actor: Actor): Promise<SectionView> {
    const created = await this.prisma.sections
      .create({
        data: {
          branch_id: dto.branchId,
          academic_year_id: dto.academicYearId,
          level_id: dto.levelId,
          gender: dto.gender,
          name: dto.name,
          default_mode: dto.defaultMode,
          supervisor_id: dto.supervisorId,
          whatsapp_group_id: dto.whatsappGroupId,
          capacity: dto.capacity,
        },
        ...SECTION_SHAPE,
      })
      .catch(refuseSecondClass);
    await this.audit.record(actor, {
      action: 'section.create',
      entityType: 'section',
      entityId: created.id,
      after: toSection(created),
    });
    return toSection(created);
  }

  async update(
    id: string,
    dto: UpdateSectionDto,
    actor: Actor,
  ): Promise<SectionView> {
    const before = await this.prisma.sections.findUniqueOrThrow({
      where: { id },
      ...SECTION_SHAPE,
    });
    const updated = await this.prisma.sections.update({
      where: { id },
      data: {
        name: dto.name,
        default_mode: dto.defaultMode,
        supervisor_id: dto.supervisorId,
        whatsapp_group_id: dto.whatsappGroupId,
        capacity: dto.capacity,
      },
      ...SECTION_SHAPE,
    });
    await this.audit.record(actor, {
      action: 'section.update',
      entityType: 'section',
      entityId: id,
      before: toSection(before),
      after: toSection(updated),
    });
    return toSection(updated);
  }

  /**
   * R3 covers staff: a female section takes female teachers. That is enforced
   * by the composite FK `(user_id, gender) → users(id, gender)` together with
   * `(section_id, gender) → sections(id, gender)`, so a mismatch is rejected
   * by Postgres, not by a check here.
   *
   * What this method does is read the section's gender and write it into the
   * row, which is what gives the database something to reject — and then
   * translate the rejection into a message that names the actual rule, since
   * a bare 409 "foreign key violation" tells the head teacher nothing.
   */
  async assignTeacher(
    sectionId: string,
    dto: AssignTeacherDto,
    actor: Actor,
  ): Promise<SectionView> {
    const section = await this.prisma.sections.findUniqueOrThrow({
      where: { id: sectionId },
      select: { gender: true },
    });

    try {
      await this.prisma.section_teachers.create({
        data: {
          section_id: sectionId,
          user_id: dto.userId,
          gender: section.gender,
          is_primary: dto.isPrimary,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new ConflictException(
          `This section is ${section.gender}; only ${section.gender} teachers can be assigned to it`,
        );
      }
      throw error;
    }

    const updated = await this.findSection(sectionId);
    await this.audit.record(actor, {
      action: 'section.teacher.assign',
      entityType: 'section',
      entityId: sectionId,
      after: { userId: dto.userId, isPrimary: dto.isPrimary },
    });
    return toSection(updated);
  }

  async unassignTeacher(
    sectionId: string,
    userId: string,
    actor: Actor,
  ): Promise<void> {
    await this.prisma.section_teachers.delete({
      where: { section_id_user_id: { section_id: sectionId, user_id: userId } },
    });
    await this.audit.record(actor, {
      action: 'section.teacher.unassign',
      entityType: 'section',
      entityId: sectionId,
      before: { userId },
    });
  }

  // §6.4: the reminder stays off per section until coverage is adequate.
  // Two aggregate counts rather than loading the roster — this renders on
  // every section header.
  async phoneCoverage(
    sectionId: string,
    viewer: AuthenticatedUser,
  ): Promise<PhoneCoverage> {
    await this.findAccessible(sectionId, viewer);
    const [total, withPhone] = await this.prisma.$transaction([
      this.prisma.enrollments.count({
        where: { section_id: sectionId, status: 'active' },
      }),
      this.prisma.enrollments.count({
        where: {
          section_id: sectionId,
          status: 'active',
          student: {
            OR: [{ phone: { not: null } }, { whatsapp_phone: { not: null } }],
          },
        },
      }),
    ]);
    return {
      total,
      withPhone,
      percentage: total === 0 ? 0 : Math.round((withPhone / total) * 100),
    };
  }

  async listEnrollments(
    query: ListEnrollmentsQueryDto,
    viewer: AuthenticatedUser,
  ): Promise<Page<EnrollmentView>> {
    const where: Prisma.enrollmentsWhereInput = {
      ...enrollmentScope(viewer),
      ...(query.sectionId ? { section_id: query.sectionId } : {}),
      ...(query.studentId ? { student_id: query.studentId } : {}),
      ...(query.academicYearId
        ? { academic_year_id: query.academicYearId }
        : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.enrollments.findMany({
        where,
        ...ENROLLMENT_SHAPE,
        orderBy: { student: { full_name: 'asc' } },
        ...toPrismaPage(query),
      }),
      this.prisma.enrollments.count({ where }),
    ]);

    // One grouped read for the page's pending carries, rather than a per-row
    // query: the carry's `enrollment_id` is the enrolment that inherited the
    // debt, so this counts exactly "subjects owed from an earlier level".
    const carryCounts = await this.prisma.carried_subjects.groupBy({
      by: ['enrollment_id'],
      where: { status: 'pending', enrollment_id: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    const pendingByEnrollment = new Map(
      carryCounts.map((row) => [row.enrollment_id, row._count._all]),
    );

    return buildPage(
      rows.map((row) => toEnrollment(row, pendingByEnrollment.get(row.id) ?? 0)),
      total,
      query,
    );
  }

  /**
   * `enrollments` denormalises gender, academic_year_id and branch_id from the
   * section (§5.1), each guarded by a composite FK. They are read from the
   * section here rather than accepted from the client precisely so the FK has
   * a consistent pair to check: a client-supplied gender that disagreed with
   * the section would be rejected by Postgres, but a client should never have
   * been in a position to supply one.
   */
  async createEnrollment(
    dto: CreateEnrollmentDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<EnrollmentView> {
    const section = await this.findAccessible(dto.sectionId, viewer);

    try {
      const created = await this.prisma.enrollments.create({
        data: {
          student_id: dto.studentId,
          section_id: dto.sectionId,
          academic_year_id: section.academic_year_id,
          branch_id: section.branch_id,
          gender: section.gender,
          entry_type: dto.entryType,
          default_attendance_mode: dto.defaultAttendanceMode,
          created_by: actor.userId,
        },
        ...ENROLLMENT_SHAPE,
      });

      await this.audit.record(actor, {
        action: 'enrollment.create',
        entityType: 'enrollment',
        entityId: created.id,
        after: toEnrollment(created),
      });
      return toEnrollment(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        // The composite FK (student_id, gender) → students(id, gender) is what
        // fails here, and it is the whole point of R3: a roster cannot mix.
        throw new ConflictException(
          `This section is ${section.gender}; a student of a different gender cannot be enrolled in it`,
        );
      }
      throw error;
    }
  }

  async updateEnrollment(
    id: string,
    dto: UpdateEnrollmentDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<EnrollmentView> {
    const before = await this.prisma.enrollments.findUniqueOrThrow({
      where: { id },
      ...ENROLLMENT_SHAPE,
    });
    await this.findAccessible(before.section_id, viewer);

    const updated = await this.prisma.enrollments.update({
      where: { id },
      data: {
        status: dto.status,
        default_attendance_mode: dto.defaultAttendanceMode,
      },
      ...ENROLLMENT_SHAPE,
    });
    await this.audit.record(actor, {
      action: 'enrollment.update',
      entityType: 'enrollment',
      entityId: id,
      before: toEnrollment(before),
      after: toEnrollment(updated),
    });
    return toEnrollment(updated);
  }

  /**
   * Moves a student to another section — the correction for a wrong study year
   * (a legacy import filed them at the wrong level, or a later fix). Only the
   * section changes; the enrollment id is kept, so its attendance and results
   * stay attached. The move stays within the same academic year and gender: a
   * different year is a different enrollment, and R3 forbids crossing genders.
   * `branch_id` is re-read from the target so every composite FK keeps a
   * matching pair.
   */
  async transferEnrollment(
    id: string,
    dto: TransferEnrollmentDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<EnrollmentView> {
    const before = await this.prisma.enrollments.findUniqueOrThrow({
      where: { id },
      ...ENROLLMENT_SHAPE,
    });
    // The viewer must be able to reach both the current and the target section.
    await this.findAccessible(before.section_id, viewer);
    const target = await this.findAccessible(dto.sectionId, viewer);

    if (target.id === before.section_id) return toEnrollment(before);
    if (target.academic_year_id !== before.academic_year_id) {
      throw new BadRequestException('A transfer must stay within the same academic year');
    }
    if (target.gender !== before.gender) {
      throw new ConflictException(
        `That section is ${target.gender}; a student of a different gender cannot be moved into it`,
      );
    }

    const updated = await this.prisma.enrollments.update({
      where: { id },
      data: { section_id: target.id, branch_id: target.branch_id },
      ...ENROLLMENT_SHAPE,
    });
    await this.audit.record(actor, {
      action: 'enrollment.transfer',
      entityType: 'enrollment',
      entityId: id,
      before: toEnrollment(before),
      after: toEnrollment(updated),
    });
    return toEnrollment(updated);
  }

  private async findSection(id: string): Promise<SectionRecord> {
    return this.prisma.sections.findUniqueOrThrow({
      where: { id },
      ...SECTION_SHAPE,
    });
  }

  /**
   * The write-side counterpart to `sectionScope`. A read filtered by a
   * where-fragment simply returns nothing; a write addressed by id has to be
   * refused explicitly, and this is the single place that refusal is decided.
   */
  private async findAccessible(
    id: string,
    viewer: AuthenticatedUser,
  ): Promise<SectionRecord> {
    const section = await this.prisma.sections.findUnique({
      where: { id },
      ...SECTION_SHAPE,
    });
    if (!section) {
      throw new NotFoundException('Section not found');
    }
    const assignments = section.section_teachers;
    if (
      !canAccessSection(viewer, {
        branch_id: section.branch_id,
        section_teachers: assignments,
      })
    ) {
      throw new ForbiddenException('This section is not assigned to you');
    }
    return section;
  }
}

function toSection(row: SectionRecord): SectionView {
  return {
    id: row.id,
    branchId: row.branch_id,
    academicYearId: row.academic_year_id,
    levelId: row.level_id,
    gender: row.gender,
    name: row.name,
    defaultMode: row.default_mode,
    supervisorId: row.supervisor_id,
    whatsappGroupId: row.whatsapp_group_id,
    capacity: row.capacity,
    enrolledCount: row._count.enrollments,
    teachers: row.section_teachers.map((assignment) => ({
      userId: assignment.user_id,
      fullName: assignment.user.full_name,
      isPrimary: assignment.is_primary,
    })),
  };
}

/** `pendingCarryCount` is supplied by the roster read (it groups carries for the
 *  whole page at once); the single-row write paths have no carries to show and
 *  pass the default. */
function toEnrollment(row: EnrollmentRecord, pendingCarryCount = 0): EnrollmentView {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student.full_name,
    sectionId: row.section_id,
    academicYearId: row.academic_year_id,
    branchId: row.branch_id,
    gender: row.gender,
    entryType: row.entry_type,
    status: row.status,
    defaultAttendanceMode: row.default_attendance_mode,
    finalDecision: row.final_decision,
    isHistorical: row.is_historical,
    pendingCarryCount,
  };
}
