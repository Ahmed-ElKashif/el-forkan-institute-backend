import {
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
  CreateSectionDto,
  ListEnrollmentsQueryDto,
  ListSectionsQueryDto,
  UpdateEnrollmentDto,
  UpdateSectionDto,
} from './dto/section.schema';

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
  studentCode: string;
  sectionId: string;
  academicYearId: number;
  branchId: number;
  gender: string;
  entryType: string;
  status: string;
  defaultAttendanceMode: string;
  finalDecision: string | null;
  isHistorical: boolean;
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
    _count: { select: { enrollments: true } },
  },
} satisfies Prisma.sectionsDefaultArgs;

type SectionRecord = Prisma.sectionsGetPayload<typeof SECTION_SHAPE>;

const ENROLLMENT_SHAPE = {
  include: {
    student: { select: { full_name: true, student_code: true } },
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

  async create(dto: CreateSectionDto, actor: Actor): Promise<SectionView> {
    const created = await this.prisma.sections.create({
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
    });
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
    return buildPage(rows.map(toEnrollment), total, query);
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

function toEnrollment(row: EnrollmentRecord): EnrollmentView {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student.full_name,
    studentCode: row.student.student_code,
    sectionId: row.section_id,
    academicYearId: row.academic_year_id,
    branchId: row.branch_id,
    gender: row.gender,
    entryType: row.entry_type,
    status: row.status,
    defaultAttendanceMode: row.default_attendance_mode,
    finalDecision: row.final_decision,
    isHistorical: row.is_historical,
  };
}
