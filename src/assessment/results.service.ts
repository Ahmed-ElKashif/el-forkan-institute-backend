import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canAccessBranch, canAccessSection } from '../common/access-scope';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveOutcome, weightedTermTotal } from '../rules/scoring';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { CorrectScoreDto, SaveScoresDto } from './dto/assessment.schema';

export interface ScoreRow {
  enrollmentId: string;
  studentName: string;
  studentCode: string;
  resultId: string | null;
  score: number | null;
  isAbsent: boolean;
  result: string;
}

export interface ScoreGrid {
  examId: string;
  subjectNameAr: string;
  maxScore: number;
  passScore: number;
  gradingMode: string;
  isLocked: boolean;
  rows: ScoreRow[];
}

export interface TermResultView {
  enrollmentId: string;
  studentName: string;
  totalScore: number | null;
  maxTotal: number | null;
  percentage: number | null;
  subjectsFailed: number;
  mandatoryFailed: number;
  result: string;
  decision: string | null;
  finalizedAt: string | null;
}

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The grid a teacher types marks into: one row per *eligible* enrolment.
   * Driven off `exam_eligibility` rather than off enrolments, so a student the
   * head teacher excluded (low attendance, already passed) does not appear
   * with an empty box inviting a mark.
   */
  /**
   * Loads an exam and refuses if the viewer's branch may not see it (F1).
   * Returns the exam so a caller that needs it does not fetch it twice.
   */
  private async loadVisibleExam<T extends Prisma.examsInclude>(
    examId: string,
    viewer: AuthenticatedUser,
    include: T,
  ): Promise<Prisma.examsGetPayload<{ include: T }>> {
    const exam = await this.prisma.exams.findUnique({
      where: { id: examId },
      include,
    });
    if (!exam || !canAccessBranch(viewer, exam.branch_id)) {
      throw new NotFoundException('Exam not found');
    }
    return exam;
  }

  /**
   * Every enrolment held by the students behind `enrollmentIds`.
   *
   * A carry is attached to the enrolment that *inherited* the debt, not the one
   * that incurred it, so a student sitting L3 carries an L1 failure on their L3
   * row. Reaching that row from the enrolment being marked means going through
   * the student — §4.6: "the engine must scan `carried_subjects` across all
   * prior enrollments, not just last year's".
   */
  private async enrollmentsOfSameStudents(
    tx: Prisma.TransactionClient,
    enrollmentIds: string[],
  ): Promise<string[]> {
    const marked = await tx.enrollments.findMany({
      where: { id: { in: enrollmentIds } },
      select: { student_id: true },
    });
    const siblings = await tx.enrollments.findMany({
      where: { student_id: { in: marked.map((row) => row.student_id) } },
      select: { id: true },
    });
    return siblings.map((row) => row.id);
  }

  /**
   * Settles carried debt: passing a subject clears every pending carry for it.
   *
   * Until this existed a carry stayed `pending` forever, and R20's COMP gate —
   * which refuses entry while any carry is pending — locked the student out of
   * the terminal level permanently, however many times they re-sat the paper.
   *
   * A carry is never written as `failed`. Nothing in the spec says when debt
   * becomes permanent, and inventing a rule here would silently change who may
   * enter COMP.
   */
  private async clearCarriesFor(
    tx: Prisma.TransactionClient,
    subjectId: number,
    enrollmentIds: string[],
  ): Promise<number> {
    if (enrollmentIds.length === 0) {
      return 0;
    }
    const { count } = await tx.carried_subjects.updateMany({
      where: {
        status: 'pending',
        subject_id: subjectId,
        enrollment_id: {
          in: await this.enrollmentsOfSameStudents(tx, enrollmentIds),
        },
      },
      data: { status: 'cleared', cleared_at: new Date() },
    });
    return count;
  }

  /**
   * The mirror of {@link clearCarriesFor}, for an R8 correction that turns a
   * pass back into a fail. Without it the debt would stay settled on the
   * strength of a mark that no longer exists, and the student would walk
   * through the COMP gate on a subject they have not passed.
   */
  private async reopenCarriesFor(
    tx: Prisma.TransactionClient,
    subjectId: number,
    enrollmentIds: string[],
  ): Promise<number> {
    if (enrollmentIds.length === 0) {
      return 0;
    }
    const { count } = await tx.carried_subjects.updateMany({
      where: {
        status: 'cleared',
        subject_id: subjectId,
        enrollment_id: {
          in: await this.enrollmentsOfSameStudents(tx, enrollmentIds),
        },
      },
      data: { status: 'pending', cleared_at: null },
    });
    return count;
  }

  async getScoreGrid(
    examId: string,
    viewer: AuthenticatedUser,
  ): Promise<ScoreGrid> {
    const exam = await this.loadVisibleExam(examId, viewer, {
      curriculum: { include: { subjects: { select: { name_ar: true } } } },
    });

    const eligible = await this.prisma.exam_eligibility.findMany({
      where: { exam_id: examId, is_eligible: true },
      include: {
        enrollments: {
          include: {
            student: { select: { full_name: true, student_code: true } },
            exam_results: { where: { exam_id: examId } },
          },
        },
      },
      orderBy: { enrollments: { student: { full_name: 'asc' } } },
    });

    return {
      examId,
      subjectNameAr: exam.curriculum.subjects.name_ar,
      maxScore: exam.curriculum.max_score.toNumber(),
      passScore: exam.curriculum.pass_score.toNumber(),
      gradingMode: exam.curriculum.grading_mode,
      isLocked: exam.is_locked,
      rows: eligible.map((row) => {
        const [existing] = row.enrollments.exam_results;
        return {
          enrollmentId: row.enrollment_id,
          studentName: row.enrollments.student.full_name,
          studentCode: row.enrollments.student.student_code,
          resultId: existing?.id ?? null,
          score: existing?.score?.toNumber() ?? null,
          isAbsent: existing?.is_absent ?? false,
          result: existing?.result ?? 'pending',
        };
      }),
    };
  }

  /**
   * Saves the whole paper. Before the lock, anyone may enter marks (§3, "Enter
   * exam scores (before lock) ✅ both roles"); after it, only the head teacher
   * may change one, and only through `correctScore`, which records the reason
   * (R8). That is why this refuses outright on a locked exam rather than
   * silently ignoring the entries.
   */
  async saveScores(
    examId: string,
    dto: SaveScoresDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{ saved: number }> {
    const exam = await this.loadVisibleExam(examId, viewer, {
      curriculum: true,
    });
    if (exam.is_locked) {
      throw new ConflictException(
        'This exam is locked; a locked grade can only be changed by the head teacher, with a reason',
      );
    }

    // F2: the grid is built from `exam_eligibility` (getScoreGrid), but the save
    // previously trusted whatever `enrollmentId`s the body carried, letting a
    // teacher write a mark for any enrolment in any branch — and re-admit a
    // student the head teacher had excluded. Re-check every child against the
    // eligible set for THIS exam and reject anything outside it.
    const eligibleIds = new Set(
      (
        await this.prisma.exam_eligibility.findMany({
          where: { exam_id: examId, is_eligible: true },
          select: { enrollment_id: true },
        })
      ).map((row) => row.enrollment_id),
    );
    for (const entry of dto.entries) {
      if (!eligibleIds.has(entry.enrollmentId)) {
        throw new BadRequestException(
          'A submitted enrolment is not eligible for this exam; refresh the grid',
        );
      }
    }

    const marking = {
      maxScore: exam.curriculum.max_score.toNumber(),
      passScore: exam.curriculum.pass_score.toNumber(),
      gradingMode: exam.curriculum.grading_mode,
      weight: exam.curriculum.weight.toNumber(),
    };

    for (const entry of dto.entries) {
      if (entry.score !== null && entry.score > marking.maxScore) {
        throw new BadRequestException(
          `A score of ${entry.score} exceeds this subject's maximum of ${marking.maxScore}`,
        );
      }
    }

    // Interactive rather than an array of promises: the carries can only be
    // settled once every mark on the paper is written, and both halves must
    // land together — a pass that cleared no debt is the bug this fixes.
    const carriesCleared = await this.prisma.$transaction(async (tx) => {
      const passed: string[] = [];
      for (const entry of dto.entries) {
        const result = resolveOutcome(
          { score: entry.score, isAbsent: entry.isAbsent },
          marking,
        );
        // A scored subject with no mark yet is 'pending', not a fail: the
        // teacher has simply not typed it. resolveOutcome cannot know that,
        // so the distinction is made here.
        const stored =
          !entry.isAbsent && entry.score === null ? 'pending' : result;
        if (stored === 'pass') {
          passed.push(entry.enrollmentId);
        }
        await tx.exam_results.upsert({
          where: {
            exam_id_enrollment_id: {
              exam_id: examId,
              enrollment_id: entry.enrollmentId,
            },
          },
          create: {
            exam_id: examId,
            enrollment_id: entry.enrollmentId,
            score: entry.score,
            is_absent: entry.isAbsent,
            result: stored,
            entered_by: actor.userId,
          },
          update: {
            score: entry.score,
            is_absent: entry.isAbsent,
            result: stored,
            updated_by: actor.userId,
            updated_at: new Date(),
          },
        });
      }
      return this.clearCarriesFor(tx, exam.curriculum.subject_id, passed);
    });

    await this.audit.record(actor, {
      action: 'exam.scores.save',
      entityType: 'exam',
      entityId: examId,
      after: { entries: dto.entries.length, carriesCleared },
    });
    return { saved: dto.entries.length };
  }

  /** Locking freezes the paper; after this only R8 corrections are possible. */
  async setLocked(
    examId: string,
    isLocked: boolean,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{ isLocked: boolean }> {
    await this.loadVisibleExam(examId, viewer, {});
    const updated = await this.prisma.exams.update({
      where: { id: examId },
      data: { is_locked: isLocked, locked_at: isLocked ? new Date() : null },
    });
    await this.audit.record(actor, {
      action: isLocked ? 'exam.lock' : 'exam.unlock',
      entityType: 'exam',
      entityId: examId,
      after: { isLocked },
    });
    return { isLocked: updated.is_locked };
  }

  /**
   * R8 — "Only the head teacher may change a grade after entry; every change
   * logged with a mandatory reason."
   *
   * The `grade_changes` row is written in the same transaction as the update,
   * so a correction can never exist without its justification.
   */
  async correctScore(
    resultId: string,
    dto: CorrectScoreDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<ScoreRow> {
    const before = await this.prisma.exam_results.findUniqueOrThrow({
      where: { id: resultId },
      include: {
        exams: { include: { curriculum: true } },
        enrollments: {
          include: {
            student: { select: { full_name: true, student_code: true } },
          },
        },
      },
    });
    // F1: even a head teacher may be branch-bound; a correction must stay inside
    // the branch that owns the exam.
    if (!canAccessBranch(viewer, before.exams.branch_id)) {
      throw new NotFoundException('Exam result not found');
    }

    const marking = {
      maxScore: before.exams.curriculum.max_score.toNumber(),
      passScore: before.exams.curriculum.pass_score.toNumber(),
      gradingMode: before.exams.curriculum.grading_mode,
      weight: before.exams.curriculum.weight.toNumber(),
    };
    if (dto.score !== null && dto.score > marking.maxScore) {
      throw new BadRequestException(
        `A score of ${dto.score} exceeds this subject's maximum of ${marking.maxScore}`,
      );
    }

    const newResult = resolveOutcome(
      { score: dto.score, isAbsent: dto.isAbsent },
      marking,
    );

    const { row: updated, carries } = await this.prisma.$transaction(
      async (tx) => {
        const row = await tx.exam_results.update({
          where: { id: resultId },
          data: {
            score: dto.score,
            is_absent: dto.isAbsent,
            result: newResult,
            updated_by: actor.userId,
            updated_at: new Date(),
          },
        });
        await tx.grade_changes.create({
          data: {
            exam_result_id: resultId,
            old_score: before.score,
            new_score: dto.score,
            old_result: before.result,
            new_result: newResult,
            reason: dto.reason,
            changed_by: actor.userId,
          },
        });
        // A correction moves the verdict in either direction, and the carry has
        // to follow it. Clearing on a pass but never reopening on a reversal
        // would leave debt settled on the strength of a mark that no longer
        // exists — the student would pass the COMP gate on a subject they have
        // not passed.
        const subjectId = before.exams.curriculum.subject_id;
        return {
          row,
          carries:
            newResult === 'pass'
              ? {
                  cleared: await this.clearCarriesFor(tx, subjectId, [
                    before.enrollment_id,
                  ]),
                }
              : {
                  reopened: await this.reopenCarriesFor(tx, subjectId, [
                    before.enrollment_id,
                  ]),
                },
        };
      },
    );

    await this.audit.record(actor, {
      action: 'exam.score.correct',
      entityType: 'exam_result',
      entityId: resultId,
      before: {
        score: before.score?.toNumber() ?? null,
        result: before.result,
      },
      after: {
        score: dto.score,
        result: newResult,
        reason: dto.reason,
        ...carries,
      },
    });

    return {
      enrollmentId: updated.enrollment_id,
      studentName: before.enrollments.student.full_name,
      studentCode: before.enrollments.student.student_code,
      resultId: updated.id,
      score: updated.score?.toNumber() ?? null,
      isAbsent: updated.is_absent,
      result: updated.result,
    };
  }

  /**
   * §4.2 weighted totals, frozen into `term_results`.
   *
   * "Materialised, not cached: term_results freezes on finalisation even if a
   * grade is later corrected under audit" — so a finalised row is never
   * recomputed, and the R8 correction trail is what explains any divergence.
   */
  async computeTermResults(
    termId: number,
    sectionId: string,
    actor: Actor,
    finalize: boolean,
    viewer: AuthenticatedUser,
  ): Promise<TermResultView[]> {
    // F1: the section must be one the viewer may act on — same branch, and (for
    // a teacher) actually assigned to them. Mirrors AttendanceService.
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
      throw new ForbiddenException('This section is not assigned to you');
    }

    const enrollments = await this.prisma.enrollments.findMany({
      where: { section_id: sectionId, status: 'active' },
      include: {
        student: { select: { full_name: true } },
        exam_results: {
          where: { exams: { term_id: termId } },
          include: { exams: { include: { curriculum: true } } },
        },
        term_results: { where: { term_id: termId } },
      },
      orderBy: { student: { full_name: 'asc' } },
    });

    const views: TermResultView[] = [];
    for (const enrollment of enrollments) {
      const [existing] = enrollment.term_results;
      if (existing?.finalized_at) {
        // Frozen. Recomputing would silently rewrite a published result.
        views.push(toTermResultView(existing, enrollment.student.full_name));
        continue;
      }

      const entries = enrollment.exam_results.map((row) => ({
        score: row.score?.toNumber() ?? null,
        isAbsent: row.is_absent,
        marking: {
          maxScore: row.exams.curriculum.max_score.toNumber(),
          passScore: row.exams.curriculum.pass_score.toNumber(),
          gradingMode: row.exams.curriculum.grading_mode,
          weight: row.exams.curriculum.weight.toNumber(),
        },
      }));
      const total = weightedTermTotal(entries);

      // R14: failures are counted at the leaf, which is exactly what an
      // exam_results row is — one per examinable curriculum row.
      const failed = enrollment.exam_results.filter(
        (row) => row.result === 'fail' || row.result === 'absent',
      );
      const mandatoryFailed = failed.filter(
        (row) => row.exams.curriculum.is_mandatory,
      );

      const saved = await this.prisma.term_results.upsert({
        where: {
          enrollment_id_term_id: {
            enrollment_id: enrollment.id,
            term_id: termId,
          },
        },
        create: {
          enrollment_id: enrollment.id,
          term_id: termId,
          total_score: total.totalScore,
          max_total: total.maxTotal,
          percentage: total.percentage,
          subjects_failed: failed.length,
          mandatory_failed: mandatoryFailed.length,
          result: failed.length === 0 ? 'pass' : 'fail',
          ...(finalize
            ? { finalized_by: actor.userId, finalized_at: new Date() }
            : {}),
        },
        update: {
          total_score: total.totalScore,
          max_total: total.maxTotal,
          percentage: total.percentage,
          subjects_failed: failed.length,
          mandatory_failed: mandatoryFailed.length,
          result: failed.length === 0 ? 'pass' : 'fail',
          computed_at: new Date(),
          ...(finalize
            ? { finalized_by: actor.userId, finalized_at: new Date() }
            : {}),
        },
      });
      views.push(toTermResultView(saved, enrollment.student.full_name));
    }

    await this.audit.record(actor, {
      action: finalize ? 'term_results.finalize' : 'term_results.compute',
      entityType: 'section',
      entityId: sectionId,
      after: { termId, rows: views.length },
    });
    return views;
  }
}

function toTermResultView(
  row: {
    enrollment_id: string;
    total_score: Prisma.Decimal | null;
    max_total: Prisma.Decimal | null;
    percentage: Prisma.Decimal | null;
    subjects_failed: number;
    mandatory_failed: number;
    result: string;
    decision: string | null;
    finalized_at: Date | null;
  },
  studentName: string,
): TermResultView {
  return {
    enrollmentId: row.enrollment_id,
    studentName,
    totalScore: row.total_score?.toNumber() ?? null,
    maxTotal: row.max_total?.toNumber() ?? null,
    percentage: row.percentage?.toNumber() ?? null,
    subjectsFailed: row.subjects_failed,
    mandatoryFailed: row.mandatory_failed,
    result: row.result,
    decision: row.decision,
    finalizedAt: row.finalized_at?.toISOString() ?? null,
  };
}
