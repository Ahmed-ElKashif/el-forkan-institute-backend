import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildCurriculumTree, CurriculumNode } from './curriculum-tree';
import type {
  CreateCurriculumDto,
  CreateCurriculumUnitDto,
  ListCurriculumQueryDto,
  UpdateCurriculumDto,
  UpdateCurriculumUnitDto,
} from './dto/curriculum.schema';

export interface CurriculumUnitView {
  id: number;
  bookId: number | null;
  bookTitleAr: string | null;
  unitLabel: string | null;
  syllabusScopeAr: string;
  alternativeGroup: number | null;
  sortOrder: number;
}

export interface CurriculumRowView {
  id: number;
  academicYearId: number;
  levelId: number;
  termNumber: number;
  subjectId: number;
  subjectNameAr: string;
  parentCurriculumId: number | null;
  isExaminable: boolean;
  isMandatory: boolean;
  gradingMode: string;
  assessmentType: string;
  maxScore: number;
  passScore: number;
  weight: number;
  teachingOrder: number | null;
  units: CurriculumUnitView[];
}

const ROW_SHAPE = {
  include: {
    subjects: { select: { name_ar: true } },
    curriculum_units: {
      include: { books: { select: { title_ar: true } } },
      orderBy: { sort_order: 'asc' },
    },
  },
} satisfies Prisma.curriculumDefaultArgs;

type CurriculumRecord = Prisma.curriculumGetPayload<typeof ROW_SHAPE>;

@Injectable()
export class CurriculumService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listTree(
    academicYearId: number,
    query: ListCurriculumQueryDto,
  ): Promise<CurriculumNode<CurriculumRowView>[]> {
    // One query for the whole screen: rows, their subject names, their units
    // and each unit's book. Fetching units per row would be N+1 across a
    // syllabus that is ~20 rows per level.
    const rows = await this.prisma.curriculum.findMany({
      where: {
        academic_year_id: academicYearId,
        ...(query.levelId ? { level_id: query.levelId } : {}),
        ...(query.termNumber ? { term_number: query.termNumber } : {}),
      },
      ...ROW_SHAPE,
      orderBy: [
        { term_number: 'asc' },
        { teaching_order: 'asc' },
        { id: 'asc' },
      ],
    });
    return buildCurriculumTree(rows.map(toCurriculumRow));
  }

  async create(
    academicYearId: number,
    levelId: number,
    dto: CreateCurriculumDto,
    actor: Actor,
  ): Promise<CurriculumRowView> {
    if (dto.parentCurriculumId !== null) {
      await this.assertCanParent(dto.parentCurriculumId);
    }

    const created = await this.prisma.curriculum.create({
      data: {
        academic_year_id: academicYearId,
        level_id: levelId,
        subject_id: dto.subjectId,
        term_number: dto.termNumber,
        parent_curriculum_id: dto.parentCurriculumId,
        is_examinable: dto.isExaminable,
        is_mandatory: dto.isMandatory,
        grading_mode: dto.gradingMode,
        assessment_type: dto.assessmentType,
        max_score: dto.maxScore,
        pass_score: dto.passScore,
        weight: dto.weight,
        teaching_order: dto.teachingOrder,
        updated_by: actor.userId,
      },
      ...ROW_SHAPE,
    });

    const view = toCurriculumRow(created);
    await this.audit.record(actor, {
      action: 'curriculum.create',
      entityType: 'curriculum',
      entityId: String(created.id),
      after: view,
    });
    return view;
  }

  async update(
    id: number,
    dto: UpdateCurriculumDto,
    actor: Actor,
  ): Promise<CurriculumRowView> {
    const before = await this.prisma.curriculum.findUniqueOrThrow({
      where: { id },
      ...ROW_SHAPE,
    });

    if (dto.parentCurriculumId) {
      if (dto.parentCurriculumId === id) {
        throw new BadRequestException('A subject cannot be its own parent');
      }
      await this.assertCanParent(dto.parentCurriculumId);
      await this.assertHasNoChildren(
        id,
        'A subject with sub-subjects cannot itself become a sub-subject',
      );
    }
    if (dto.isExaminable === true) {
      await this.assertHasNoChildren(
        id,
        'A subject with sub-subjects is a container: the exam, score and carry belong to its children',
      );
    }

    const passScore = dto.passScore ?? before.pass_score.toNumber();
    const maxScore = dto.maxScore ?? before.max_score.toNumber();
    if (passScore > maxScore) {
      throw new BadRequestException('passScore must not exceed maxScore');
    }

    const updated = await this.prisma.curriculum.update({
      where: { id },
      data: {
        parent_curriculum_id: dto.parentCurriculumId,
        is_examinable: dto.isExaminable,
        is_mandatory: dto.isMandatory,
        grading_mode: dto.gradingMode,
        assessment_type: dto.assessmentType,
        max_score: dto.maxScore,
        pass_score: dto.passScore,
        weight: dto.weight,
        teaching_order: dto.teachingOrder,
        updated_by: actor.userId,
        updated_at: new Date(),
      },
      ...ROW_SHAPE,
    });

    const view = toCurriculumRow(updated);
    await this.audit.record(actor, {
      action: 'curriculum.update',
      entityType: 'curriculum',
      entityId: String(id),
      before: toCurriculumRow(before),
      after: view,
    });
    return view;
  }

  async remove(id: number, actor: Actor): Promise<void> {
    const before = await this.prisma.curriculum.findUniqueOrThrow({
      where: { id },
      ...ROW_SHAPE,
    });
    await this.assertHasNoChildren(
      id,
      'Remove the sub-subjects before removing their parent',
    );
    // Exams point at curriculum with ON DELETE NO ACTION, so a row that has
    // ever been examined refuses to disappear — that refusal arrives as a 409
    // through PrismaExceptionFilter, which is the correct answer: deleting it
    // would orphan real results.
    await this.prisma.curriculum.delete({ where: { id } });

    await this.audit.record(actor, {
      action: 'curriculum.delete',
      entityType: 'curriculum',
      entityId: String(id),
      before: toCurriculumRow(before),
    });
  }

  async addUnit(
    curriculumId: number,
    dto: CreateCurriculumUnitDto,
    actor: Actor,
  ): Promise<CurriculumUnitView> {
    const created = await this.prisma.curriculum_units.create({
      data: {
        curriculum_id: curriculumId,
        book_id: dto.bookId,
        unit_label: dto.unitLabel,
        syllabus_scope_ar: dto.syllabusScopeAr,
        alternative_group: dto.alternativeGroup,
        sort_order: dto.sortOrder,
        updated_by: actor.userId,
      },
      include: { books: { select: { title_ar: true } } },
    });
    await this.audit.record(actor, {
      action: 'curriculum.unit.add',
      entityType: 'curriculum',
      entityId: String(curriculumId),
      after: toUnit(created),
    });
    return toUnit(created);
  }

  async updateUnit(
    id: number,
    dto: UpdateCurriculumUnitDto,
    actor: Actor,
  ): Promise<CurriculumUnitView> {
    const before = await this.prisma.curriculum_units.findUniqueOrThrow({
      where: { id },
      include: { books: { select: { title_ar: true } } },
    });
    const updated = await this.prisma.curriculum_units.update({
      where: { id },
      data: {
        book_id: dto.bookId,
        unit_label: dto.unitLabel,
        syllabus_scope_ar: dto.syllabusScopeAr,
        alternative_group: dto.alternativeGroup,
        sort_order: dto.sortOrder,
        updated_by: actor.userId,
        updated_at: new Date(),
      },
      include: { books: { select: { title_ar: true } } },
    });
    await this.audit.record(actor, {
      action: 'curriculum.unit.update',
      entityType: 'curriculum',
      entityId: String(before.curriculum_id),
      before: toUnit(before),
      after: toUnit(updated),
    });
    return toUnit(updated);
  }

  async removeUnit(id: number, actor: Actor): Promise<void> {
    const before = await this.prisma.curriculum_units.findUniqueOrThrow({
      where: { id },
      include: { books: { select: { title_ar: true } } },
    });
    await this.prisma.curriculum_units.delete({ where: { id } });
    await this.audit.record(actor, {
      action: 'curriculum.unit.remove',
      entityType: 'curriculum',
      entityId: String(before.curriculum_id),
      before: toUnit(before),
    });
  }

  /**
   * §4.1: depth is capped at two in the application layer, and a parent is a
   * container rather than an examined subject. The composite FK already forces
   * parent and child to share (year, level, term); these are the two rules the
   * database cannot express.
   */
  private async assertCanParent(parentId: number): Promise<void> {
    const parent = await this.prisma.curriculum.findUniqueOrThrow({
      where: { id: parentId },
      select: { parent_curriculum_id: true, is_examinable: true },
    });
    if (parent.parent_curriculum_id !== null) {
      throw new BadRequestException(
        'Sub-subjects cannot themselves have sub-subjects (nesting is capped at two levels)',
      );
    }
    if (parent.is_examinable) {
      throw new BadRequestException(
        'Mark the parent subject as not examinable first: a parent is a container, and the exam belongs to its children',
      );
    }
  }

  private async assertHasNoChildren(
    id: number,
    message: string,
  ): Promise<void> {
    const children = await this.prisma.curriculum.count({
      where: { parent_curriculum_id: id },
    });
    if (children > 0) {
      throw new BadRequestException(message);
    }
  }
}

function toUnit(row: {
  id: number;
  book_id: number | null;
  books: { title_ar: string } | null;
  unit_label: string | null;
  syllabus_scope_ar: string;
  alternative_group: number | null;
  sort_order: number;
}): CurriculumUnitView {
  return {
    id: row.id,
    bookId: row.book_id,
    bookTitleAr: row.books?.title_ar ?? null,
    unitLabel: row.unit_label,
    syllabusScopeAr: row.syllabus_scope_ar,
    alternativeGroup: row.alternative_group,
    sortOrder: row.sort_order,
  };
}

function toCurriculumRow(row: CurriculumRecord): CurriculumRowView {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    levelId: row.level_id,
    termNumber: row.term_number,
    subjectId: row.subject_id,
    subjectNameAr: row.subjects.name_ar,
    parentCurriculumId: row.parent_curriculum_id,
    isExaminable: row.is_examinable,
    isMandatory: row.is_mandatory,
    gradingMode: row.grading_mode,
    assessmentType: row.assessment_type,
    // Prisma returns NUMERIC as Decimal; JSON.stringify would render it as an
    // object, so it is collapsed to a number at the API boundary.
    maxScore: row.max_score.toNumber(),
    passScore: row.pass_score.toNumber(),
    weight: row.weight.toNumber(),
    teachingOrder: row.teaching_order,
    units: row.curriculum_units.map(toUnit),
  };
}
