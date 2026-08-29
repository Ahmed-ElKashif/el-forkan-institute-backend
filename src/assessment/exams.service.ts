import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { buildPage, Page, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import {
  AbsencePolicyFacts,
  checkEligibility,
  EnrollmentFacts,
  ExamFacts,
} from '../rules/eligibility';
import { resolveProgressionRules } from '../rules/promotion';
import type {
  CreateExamDto,
  ListExamsQueryDto,
  OverrideEligibilityDto,
  UpdateExamDto,
} from './dto/assessment.schema';

export interface ExamView {
  id: string;
  branchId: number;
  academicYearId: number;
  termId: number;
  curriculumId: number;
  subjectNameAr: string;
  levelId: number;
  gender: string | null;
  examType: string;
  scheduledAt: string | null;
  durationMin: number | null;
  venue: string | null;
  isLocked: boolean;
  // Inherited from the curriculum row (§4.2), never stored on the exam.
  maxScore: number;
  passScore: number;
  gradingMode: string;
}

export interface EligibilityRow {
  id: string;
  enrollmentId: string;
  studentName: string;
  studentCode: string;
  isEligible: boolean;
  reasonCode: string;
  reasonNote: string | null;
  seatNo: string | null;
  overriddenBy: string | null;
}

const EXAM_SHAPE = {
  include: {
    curriculum: {
      include: { subjects: { select: { name_ar: true } } },
    },
  },
} satisfies Prisma.examsDefaultArgs;

type ExamRecord = Prisma.examsGetPayload<typeof EXAM_SHAPE>;

const ELIGIBILITY_SHAPE = {
  include: {
    enrollments: {
      include: { student: { select: { full_name: true, student_code: true } } },
    },
  },
} satisfies Prisma.exam_eligibilityDefaultArgs;

type EligibilityRecord = Prisma.exam_eligibilityGetPayload<
  typeof ELIGIBILITY_SHAPE
>;

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListExamsQueryDto): Promise<Page<ExamView>> {
    const where: Prisma.examsWhereInput = {
      ...(query.termId ? { term_id: query.termId } : {}),
      ...(query.examType ? { exam_type: query.examType } : {}),
      ...(query.isLocked === undefined ? {} : { is_locked: query.isLocked }),
      ...(query.levelId ? { curriculum: { level_id: query.levelId } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.exams.findMany({
        where,
        ...EXAM_SHAPE,
        orderBy: [{ scheduled_at: 'asc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.exams.count({ where }),
    ]);
    return buildPage(rows.map(toExamView), total, query);
  }

  /**
   * §4.2: an exam points at an examinable curriculum row. A grouping parent
   * holds no exam of its own — the exam, the score and the carry belong to its
   * children (§4.1) — so scheduling one against a container is refused here
   * rather than producing an exam nobody can be eligible for.
   */
  async create(dto: CreateExamDto, actor: Actor): Promise<ExamView> {
    const curriculum = await this.prisma.curriculum.findUniqueOrThrow({
      where: { id: dto.curriculumId },
      select: { is_examinable: true, academic_year_id: true },
    });
    if (!curriculum.is_examinable) {
      throw new ConflictException(
        'That curriculum row is a container; schedule the exam against one of its sub-subjects',
      );
    }
    const term = await this.prisma.terms.findUniqueOrThrow({
      where: { id: dto.termId },
      select: { academic_year_id: true },
    });
    if (term.academic_year_id !== curriculum.academic_year_id) {
      throw new ConflictException(
        'That term and that curriculum row belong to different academic years',
      );
    }

    /**
     * The DDL's `UNIQUE (branch_id, term_id, curriculum_id, gender,
     * exam_type)` does NOT catch a duplicate shared sitting, because
     * `gender IS NULL` means "both genders" (R3) and Postgres treats NULLs as
     * distinct inside a unique index. Two identical shared exams would both
     * insert, and the paper would then have two score grids and two sets of
     * eligibility rows.
     *
     * `findFirst` with `gender: null` compiles to `IS NULL` and does match, so
     * the check has to live here. (Same hazard as the nullable `level_id` in
     * progression_rules and attendance_policies — see agent/memory.md.)
     */
    const duplicate = await this.prisma.exams.findFirst({
      where: {
        branch_id: dto.branchId,
        term_id: dto.termId,
        curriculum_id: dto.curriculumId,
        gender: dto.gender,
        exam_type: dto.examType,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        'An exam already exists for this subject, term, sitting and gender',
      );
    }

    const created = await this.prisma.exams.create({
      data: {
        branch_id: dto.branchId,
        academic_year_id: term.academic_year_id,
        term_id: dto.termId,
        curriculum_id: dto.curriculumId,
        gender: dto.gender,
        exam_type: dto.examType,
        scheduled_at: dto.scheduledAt,
        duration_min: dto.durationMin,
        venue: dto.venue,
        created_by: actor.userId,
      },
      ...EXAM_SHAPE,
    });

    await this.audit.record(actor, {
      action: 'exam.create',
      entityType: 'exam',
      entityId: created.id,
      after: toExamView(created),
    });
    return toExamView(created);
  }

  async update(
    id: string,
    dto: UpdateExamDto,
    actor: Actor,
  ): Promise<ExamView> {
    const before = await this.prisma.exams.findUniqueOrThrow({
      where: { id },
      ...EXAM_SHAPE,
    });
    const updated = await this.prisma.exams.update({
      where: { id },
      data: {
        scheduled_at: dto.scheduledAt,
        duration_min: dto.durationMin,
        venue: dto.venue,
      },
      ...EXAM_SHAPE,
    });
    await this.audit.record(actor, {
      action: 'exam.update',
      entityType: 'exam',
      entityId: id,
      before: toExamView(before),
      after: toExamView(updated),
    });
    return toExamView(updated);
  }

  /**
   * §4.6 — materialises `exam_eligibility`, one row per (exam × enrollment).
   *
   * Materialised rather than computed on read because the head teacher can
   * override a verdict with a reason, and an override has to survive the next
   * recomputation. Rows an override already touched are left alone.
   */
  async computeEligibility(
    examId: string,
    actor: Actor,
  ): Promise<{ eligible: number; ineligible: number }> {
    const exam = await this.prisma.exams.findUniqueOrThrow({
      where: { id: examId },
      include: { curriculum: true, terms: true },
    });

    // Every enrolment in the exam's year and branch is a candidate: a student
    // carrying a subject from an earlier level is eligible for that level's
    // makeup while sitting in a higher one (§4.6), so the candidate set cannot
    // be narrowed to the exam's own level up front.
    const enrollments = await this.prisma.enrollments.findMany({
      where: {
        academic_year_id: exam.academic_year_id,
        branch_id: exam.branch_id,
        status: 'active',
      },
      include: {
        section: { select: { level_id: true } },
        student: { select: { full_name: true } },
        carried_subjects_carried_subjects_enrollment_idToenrollments: {
          where: { status: 'pending' },
          select: { subject_id: true },
        },
        exam_results: {
          where: { result: 'pass' },
          include: { exams: { select: { curriculum_id: true } } },
        },
        attendance: {
          where: {
            status: 'absent',
            sessions: {
              session_date: {
                gte: exam.terms.starts_on,
                lte: exam.terms.ends_on,
              },
            },
          },
          select: { id: true },
        },
      },
    });

    const policy = await this.resolveAbsencePolicy(
      exam.academic_year_id,
      exam.curriculum.level_id,
    );
    const passedSubjectIds = await this.loadPassedSubjectIds(
      enrollments.map((enrollment) => enrollment.student_id),
    );
    const compClearers = await this.loadCompClearers(
      enrollments.map((enrollment) => enrollment.student_id),
    );

    const examFacts: ExamFacts = {
      levelId: exam.curriculum.level_id,
      branchId: exam.branch_id,
      gender: exam.gender,
      isExaminable: exam.curriculum.is_examinable,
    };

    let eligible = 0;
    let ineligible = 0;
    for (const enrollment of enrollments) {
      const carries =
        enrollment.carried_subjects_carried_subjects_enrollment_idToenrollments;
      const facts: EnrollmentFacts = {
        status: enrollment.status,
        entryType: enrollment.entry_type,
        levelId: enrollment.section.level_id,
        branchId: enrollment.branch_id,
        gender: enrollment.gender,
        termAbsences: enrollment.attendance.length,
        alreadyPassedSubject:
          passedSubjectIds
            .get(enrollment.student_id)
            ?.has(exam.curriculum.subject_id) ?? false,
        isCarryingExamSubject: carries.some(
          (carry) => carry.subject_id === exam.curriculum.subject_id,
        ),
        isClearingForComp: compClearers.has(enrollment.student_id),
      };

      const verdict = checkEligibility(facts, examFacts, policy);
      // Out-of-scope enrolments get no row at all: a table with a row per
      // student per exam saying "not this level" is noise the head teacher has
      // to filter past on every screen.
      if (!verdict.isEligible && verdict.reasonCode === 'not_in_scope') {
        continue;
      }

      await this.prisma.exam_eligibility.upsert({
        where: {
          exam_id_enrollment_id: {
            exam_id: examId,
            enrollment_id: enrollment.id,
          },
        },
        create: {
          exam_id: examId,
          enrollment_id: enrollment.id,
          is_eligible: verdict.isEligible,
          reason_code: verdict.reasonCode,
        },
        // An overridden row is the head teacher's decision and outranks the
        // engine; recomputing must not silently undo it.
        update: {},
      });
      if (verdict.isEligible) {
        eligible += 1;
      } else {
        ineligible += 1;
      }
    }

    await this.audit.record(actor, {
      action: 'exam.eligibility.compute',
      entityType: 'exam',
      entityId: examId,
      after: { eligible, ineligible },
    });
    return { eligible, ineligible };
  }

  async listEligibility(
    examId: string,
    reasonCode?: string,
  ): Promise<EligibilityRow[]> {
    const rows = await this.prisma.exam_eligibility.findMany({
      where: {
        exam_id: examId,
        ...(reasonCode ? { reason_code: reasonCode } : {}),
      },
      ...ELIGIBILITY_SHAPE,
      orderBy: { enrollments: { student: { full_name: 'asc' } } },
    });
    return rows.map(toEligibilityRow);
  }

  /** §4.6: "the head teacher may override with a reason." */
  async overrideEligibility(
    eligibilityId: string,
    dto: OverrideEligibilityDto,
    actor: Actor,
  ): Promise<EligibilityRow> {
    const before = await this.prisma.exam_eligibility.findUniqueOrThrow({
      where: { id: eligibilityId },
    });
    const updated = await this.prisma.exam_eligibility.update({
      where: { id: eligibilityId },
      data: {
        is_eligible: dto.isEligible,
        reason_code: 'manual_override',
        reason_note: dto.reasonNote,
        seat_no: dto.seatNo,
        overridden_by: actor.userId,
        overridden_at: new Date(),
      },
    });
    await this.audit.record(actor, {
      action: 'exam.eligibility.override',
      entityType: 'exam',
      entityId: before.exam_id,
      before: {
        isEligible: before.is_eligible,
        reasonCode: before.reason_code,
      },
      after: { isEligible: updated.is_eligible, reasonNote: dto.reasonNote },
    });
    return toEligibilityRow(
      await this.prisma.exam_eligibility.findUniqueOrThrow({
        where: { id: eligibilityId },
        ...ELIGIBILITY_SHAPE,
      }),
    );
  }

  /**
   * §4.6 resolves the level's absence policy, falling back to the year's
   * `level_id IS NULL` row — the same precedence rule as progression rules.
   */
  private async resolveAbsencePolicy(
    academicYearId: number,
    levelId: number,
  ): Promise<AbsencePolicyFacts> {
    const policies = await this.prisma.attendance_policies.findMany({
      where: { academic_year_id: academicYearId },
    });
    const policy = resolveProgressionRules(
      policies.map((row) => ({ levelId: row.level_id, row })),
      levelId,
    )?.row;
    return {
      // No policy configured means no attendance-based blocking, which is the
      // permissive reading — a missing policy must not exclude a student from
      // an exam they are otherwise entitled to sit.
      maxAbsences: policy?.max_absences ?? Number.POSITIVE_INFINITY,
      exceedingAction: policy?.exceeding_action ?? 'warn_only',
    };
  }

  /**
   * §4.6: "NOT already_passed(student, curriculum.subject)" — across every
   * enrolment the student has ever had, not just this year's. One grouped
   * query rather than one per student.
   */
  private async loadPassedSubjectIds(
    studentIds: string[],
  ): Promise<Map<string, Set<number>>> {
    const passes = await this.prisma.exam_results.findMany({
      where: {
        result: 'pass',
        enrollments: { student_id: { in: studentIds } },
      },
      select: {
        enrollments: { select: { student_id: true } },
        exams: { select: { curriculum: { select: { subject_id: true } } } },
      },
    });
    const byStudent = new Map<string, Set<number>>();
    for (const pass of passes) {
      const studentId = pass.enrollments.student_id;
      const set = byStudent.get(studentId) ?? new Set<number>();
      set.add(pass.exams.curriculum.subject_id);
      byStudent.set(studentId, set);
    }
    return byStudent;
  }

  /**
   * §4.4: students whose L4 is done but who still hold pending carries are
   * "clearing for COMP", and the head teacher needs that list ready-made —
   * "who needs which paper".
   */
  private async loadCompClearers(studentIds: string[]): Promise<Set<string>> {
    const finishedL4 = await this.prisma.enrollments.findMany({
      where: {
        student_id: { in: studentIds },
        final_decision: { in: ['promote', 'graduate', 'promote_with_carry'] },
        section: { levels: { is_terminal: true } },
      },
      select: { student_id: true },
    });
    if (finishedL4.length === 0) {
      return new Set();
    }
    const stillCarrying = await this.prisma.carried_subjects.findMany({
      where: {
        status: 'pending',
        enrollments_carried_subjects_enrollment_idToenrollments: {
          student_id: { in: finishedL4.map((row) => row.student_id) },
        },
      },
      select: {
        enrollments_carried_subjects_enrollment_idToenrollments: {
          select: { student_id: true },
        },
      },
    });
    return new Set(
      stillCarrying.map(
        (row) =>
          row.enrollments_carried_subjects_enrollment_idToenrollments
            .student_id,
      ),
    );
  }
}

function toEligibilityRow(row: EligibilityRecord): EligibilityRow {
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    studentName: row.enrollments.student.full_name,
    studentCode: row.enrollments.student.student_code,
    isEligible: row.is_eligible,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    seatNo: row.seat_no,
    overriddenBy: row.overridden_by,
  };
}

function toExamView(row: ExamRecord): ExamView {
  return {
    id: row.id,
    branchId: row.branch_id,
    academicYearId: row.academic_year_id,
    termId: row.term_id,
    curriculumId: row.curriculum_id,
    subjectNameAr: row.curriculum.subjects.name_ar,
    levelId: row.curriculum.level_id,
    gender: row.gender,
    examType: row.exam_type,
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    durationMin: row.duration_min,
    venue: row.venue,
    isLocked: row.is_locked,
    maxScore: row.curriculum.max_score.toNumber(),
    passScore: row.curriculum.pass_score.toNumber(),
    gradingMode: row.curriculum.grading_mode,
  };
}
