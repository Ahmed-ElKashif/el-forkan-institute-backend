import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  studentCode: string;
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
  whatsappOptIn: boolean;
  notes: string | null;
}

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
    const where = this.buildWhere(query, viewer);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.students.findMany({
        where,
        orderBy: { full_name: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.students.count({ where }),
    ]);
    return buildPage(rows.map(toStudent), total, query);
  }

  async getById(id: string, viewer: AuthenticatedUser): Promise<StudentView> {
    return toStudent(await this.findVisible(id, viewer));
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
        student_code: dto.studentCode ?? (await this.nextStudentCode()),
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
      student_code: dto.studentCode,
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

  /**
   * §10 item 3 leaves the format open, so this generates a stable, sortable
   * one: the Gregorian year plus a zero-padded sequence within it. Supplying
   * `studentCode` explicitly overrides it, which is what the institute's own
   * convention will use once it is decided.
   */
  private async nextStudentCode(): Promise<string> {
    const yearPrefix = String(new Date().getUTCFullYear());
    const latest = await this.prisma.students.findFirst({
      where: { student_code: { startsWith: `${yearPrefix}-` } },
      orderBy: { student_code: 'desc' },
      select: { student_code: true },
    });
    const lastSequence = latest
      ? Number.parseInt(latest.student_code.split('-')[1] ?? '0', 10)
      : 0;
    if (Number.isNaN(lastSequence)) {
      throw new BadRequestException(
        'Existing student codes do not match the generated format; supply studentCode explicitly',
      );
    }
    return `${yearPrefix}-${String(lastSequence + 1).padStart(4, '0')}`;
  }
}

function toStudent(row: StudentRecord): StudentView {
  return {
    id: row.id,
    studentCode: row.student_code,
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
    whatsappOptIn: row.whatsapp_opt_in,
    notes: row.notes,
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
