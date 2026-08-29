import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveOutcome, weightedTermTotal } from '../rules/scoring';
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
  async getScoreGrid(examId: string): Promise<ScoreGrid> {
    const exam = await this.prisma.exams.findUniqueOrThrow({
      where: { id: examId },
      include: {
        curriculum: { include: { subjects: { select: { name_ar: true } } } },
      },
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
  ): Promise<{ saved: number }> {
    const exam = await this.prisma.exams.findUniqueOrThrow({
      where: { id: examId },
      include: { curriculum: true },
    });
    if (exam.is_locked) {
      throw new ConflictException(
        'This exam is locked; a locked grade can only be changed by the head teacher, with a reason',
      );
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

    await this.prisma.$transaction(
      dto.entries.map((entry) => {
        const result = resolveOutcome(
          { score: entry.score, isAbsent: entry.isAbsent },
          marking,
        );
        // A scored subject with no mark yet is 'pending', not a fail: the
        // teacher has simply not typed it. resolveOutcome cannot know that,
        // so the distinction is made here.
        const stored =
          !entry.isAbsent && entry.score === null ? 'pending' : result;
        return this.prisma.exam_results.upsert({
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
      }),
    );

    await this.audit.record(actor, {
      action: 'exam.scores.save',
      entityType: 'exam',
      entityId: examId,
      after: { entries: dto.entries.length },
    });
    return { saved: dto.entries.length };
  }

  /** Locking freezes the paper; after this only R8 corrections are possible. */
  async setLocked(
    examId: string,
    isLocked: boolean,
    actor: Actor,
  ): Promise<{ isLocked: boolean }> {
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

    const updated = await this.prisma.$transaction(async (tx) => {
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
      return row;
    });

    await this.audit.record(actor, {
      action: 'exam.score.correct',
      entityType: 'exam_result',
      entityId: resultId,
      before: {
        score: before.score?.toNumber() ?? null,
        result: before.result,
      },
      after: { score: dto.score, result: newResult, reason: dto.reason },
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
  ): Promise<TermResultView[]> {
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
