import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canAccessBranch,
  canAccessSection,
  sectionScope,
} from '../common/access-scope';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { branchScope } from '../common/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { checkCompEntry } from '../rules/comp-gate';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  decideAfterMakeup,
  decidePromotion,
  FailedUnit,
  PromotionDecision,
  resolveProgressionRules,
} from '../rules/promotion';
import type {
  ConfirmPromotionDto,
  IssueCertificateDto,
  OverridePromotionDto,
  RunPromotionDto,
} from './dto/assessment.schema';

export interface PromotionPreviewRow {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  levelId: number;
  levelCode: string;
  failedSubjects: Array<{
    subjectId: number;
    nameAr: string;
    isMandatory: boolean;
  }>;
  /** What will actually be written: the override if there is one, otherwise
   *  {@link computedDecision}. Existing callers read this and are unaffected by
   *  overrides existing. */
  decision: PromotionDecision;
  /** What the engine worked out, always — so the screen can show the head
   *  teacher what they are disagreeing with rather than hiding it. */
  computedDecision: PromotionDecision;
  /** The recorded disagreement, or null when the engine's verdict stands. */
  override: {
    decision: PromotionDecision;
    reason: string;
    overriddenBy: string;
    overriddenAt: string;
  } | null;
  /** Set when the row cannot be decided — a missing progression rule, or a
   * historical enrolment. Rows with a blocker are never written. */
  blocker: string | null;
}

export interface CertificateView {
  id: string;
  studentId: string;
  studentName: string;
  levelId: number;
  levelCode: string;
  serialNo: string | null;
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

interface TargetSection {
  id: string;
  academic_year_id: number;
  branch_id: number;
  gender: 'male' | 'female';
}

/**
 * The facts a printed certificate is made of. §10 item 2 leaves the wording
 * and the layout to the institute, so this deliberately carries data, not
 * formatted text.
 */
export interface CertificatePrintPayload {
  certificateId: string;
  serialNo: string | null;
  studentName: string;
  studentCode: string;
  levelCode: string;
  levelNameAr: string;
  instituteNameAr: string;
  branchNameAr: string | null;
  hijriYear: number | null;
  issuedAt: string;
  issuedByName: string;
  /** 1 is the original issue; 2 and above are reprints. */
  copyNumber: number;
  notes: string | null;
}

export interface CertifiableStudent {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  levelId: number;
  levelCode: string;
  decision: string;
}

@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * §8 Phase 4 — "promotion run (preview → confirm → next year's enrollments +
   * carried subjects)".
   *
   * The preview writes nothing. It is the same computation `confirm` replays,
   * so what the head teacher approves is what gets applied.
   */
  async preview(
    dto: RunPromotionDto,
    viewer: AuthenticatedUser,
  ): Promise<PromotionPreviewRow[]> {
    const enrollments = await this.prisma.enrollments.findMany({
      where: {
        academic_year_id: dto.academicYearId,
        status: 'active',
        /* ONE `section` key, deliberately.
         *
         * The scope is a filter on `section` too, and the level filter used to
         * be spread in beside it as a second `section` key — which JavaScript
         * resolves by letting the last one win. A teacher filtering by level
         * would have silently lost their scope and previewed every enrolment at
         * that level in the branch. Merging here is what keeps both predicates.
         *
         * `sectionScope` rather than `enrollmentScope`: the latter wraps the
         * same fragment in `{ section: ... }`, which is the shape that caused
         * the collision. It returns `{}` for an institute-wide head teacher, so
         * that case still reads every branch (F1). */
        section: {
          ...sectionScope(viewer),
          ...(dto.levelId ? { level_id: dto.levelId } : {}),
        },
      },
      include: {
        student: { select: { full_name: true } },
        section: { include: { levels: true } },
        // At most one row per round (UNIQUE enrollment_id, after_makeup), so the
        // head teacher's verdict travels with the engine's rather than needing a
        // second query per student.
        promotion_overrides: { where: { after_makeup: dto.afterMakeup } },
        exam_results: {
          include: {
            exams: {
              include: {
                curriculum: {
                  include: { subjects: { select: { name_ar: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { student: { full_name: 'asc' } },
    });

    const rules = await this.prisma.progression_rules.findMany({
      where: { academic_year_id: dto.academicYearId },
    });

    return enrollments.map((enrollment) => {
      const level = enrollment.section.levels;
      const base = {
        enrollmentId: enrollment.id,
        studentId: enrollment.student_id,
        studentName: enrollment.student.full_name,
        levelId: level.id,
        levelCode: level.code,
      };

      // §4.3: "never re-run the promotion engine over historical rows." The
      // 1447 decisions were made under looser rules than R17 now allows, and
      // re-deciding them would silently rewrite real students' records.
      /* A blocked row carries no override, even if one exists. `confirm` refuses
         blocked rows outright, so surfacing an override there would offer the
         head teacher a decision the run will not honour. */
      if (enrollment.is_historical) {
        return {
          ...base,
          failedSubjects: [],
          decision: 'repeat' as PromotionDecision,
          computedDecision: 'repeat' as PromotionDecision,
          override: null,
          blocker:
            'Historical enrolment — imported from the old sheets and never re-decided',
        };
      }

      const rule = resolveProgressionRules(
        rules.map((row) => ({ levelId: row.level_id, row })),
        level.id,
      )?.row;
      if (!rule) {
        // Assuming a carry limit would decide a real student's year on a guess.
        return {
          ...base,
          failedSubjects: [],
          decision: 'repeat' as PromotionDecision,
          computedDecision: 'repeat' as PromotionDecision,
          override: null,
          blocker: `No progression rule for level ${level.code}, and no year-wide fallback`,
        };
      }

      // R14: sub-subjects are examined and carried individually, so one
      // exam_results row is one failed unit.
      const failedRows = enrollment.exam_results.filter(
        (row) => row.result === 'fail' || row.result === 'absent',
      );
      const failed: FailedUnit[] = failedRows.map((row) => ({
        subjectId: row.exams.curriculum.subject_id,
        isMandatory: row.exams.curriculum.is_mandatory,
      }));

      const levelRules = {
        allowsCarry: level.allows_carry,
        isTerminal: level.is_terminal,
      };
      const progressionRules = {
        maxCarriedSubjects: rule.max_carried_subjects,
        makeupRoundEnabled: rule.makeup_round_enabled,
        carryForwardEnabled: rule.carry_forward_enabled,
        mandatoryCanBeCarried: rule.mandatory_can_be_carried,
      };

      const computedDecision = dto.afterMakeup
        ? decideAfterMakeup(failed, levelRules, progressionRules)
        : decidePromotion(failed, levelRules, progressionRules);

      /* At most one, by UNIQUE (enrollment_id, after_makeup), and already
         filtered to this round. The stored column is `decision_t`, which also
         carries `withdrawn` — an enrolment status rather than a verdict; the
         write DTO admits only the five promotion decisions, so nothing else can
         reach this row. */
      const [recorded] = enrollment.promotion_overrides;
      const override = recorded
        ? {
            decision: recorded.decision as PromotionDecision,
            reason: recorded.reason,
            overriddenBy: recorded.overridden_by,
            overriddenAt: recorded.overridden_at.toISOString(),
          }
        : null;

      return {
        ...base,
        failedSubjects: failedRows.map((row) => ({
          subjectId: row.exams.curriculum.subject_id,
          nameAr: row.exams.curriculum.subjects.name_ar,
          isMandatory: row.exams.curriculum.is_mandatory,
        })),
        decision: override?.decision ?? computedDecision,
        computedDecision,
        override,
        blocker: null,
      };
    });
  }

  /**
   * Loads one enrolment the viewer is allowed to write to, or refuses.
   *
   * NotFound outside the branch, Forbidden inside it but on someone else's
   * class — the same distinction `SectionsService.findAccessible` draws, so a
   * teacher cannot use the error to probe another branch's roster.
   */
  private async writableEnrollment(
    enrollmentId: string,
    viewer: AuthenticatedUser,
  ): Promise<{ id: string; academic_year_id: number }> {
    const enrollment = await this.prisma.enrollments.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        academic_year_id: true,
        section: {
          select: {
            branch_id: true,
            section_teachers: { select: { user_id: true } },
          },
        },
      },
    });
    if (!enrollment || !canAccessBranch(viewer, enrollment.section.branch_id)) {
      throw new NotFoundException('Enrolment not found');
    }
    if (!canAccessSection(viewer, enrollment.section)) {
      throw new ForbiddenException('This enrolment is not in your classes');
    }
    return { id: enrollment.id, academic_year_id: enrollment.academic_year_id };
  }

  /**
   * Records a human disagreeing with the engine (§4.3).
   *
   * The reason is mandatory because it is the whole point: an override with no
   * stated reason is an unexplained rewrite of a student's year. Replacing an
   * existing override overwrites it rather than stacking, so the row always
   * reads as "the decision that stands, and why".
   *
   * This does not decide anything on its own — `confirm` still replays the
   * preview and applies what it finds, so the override has to survive that
   * replay to take effect.
   */
  async setDecisionOverride(
    enrollmentId: string,
    dto: OverridePromotionDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{ decision: PromotionDecision; afterMakeup: boolean }> {
    await this.writableEnrollment(enrollmentId, viewer);

    const before = await this.prisma.promotion_overrides.findUnique({
      where: {
        enrollment_id_after_makeup: {
          enrollment_id: enrollmentId,
          after_makeup: dto.afterMakeup,
        },
      },
    });

    await this.prisma.promotion_overrides.upsert({
      where: {
        enrollment_id_after_makeup: {
          enrollment_id: enrollmentId,
          after_makeup: dto.afterMakeup,
        },
      },
      create: {
        enrollment_id: enrollmentId,
        after_makeup: dto.afterMakeup,
        decision: dto.decision,
        reason: dto.reason,
        overridden_by: actor.userId,
      },
      update: {
        decision: dto.decision,
        reason: dto.reason,
        overridden_by: actor.userId,
        overridden_at: new Date(),
      },
    });

    await this.audit.record(actor, {
      action: 'promotion.decision.override',
      entityType: 'enrollment',
      entityId: enrollmentId,
      before: before
        ? { decision: before.decision, reason: before.reason }
        : undefined,
      after: {
        decision: dto.decision,
        reason: dto.reason,
        afterMakeup: dto.afterMakeup,
      },
    });

    return { decision: dto.decision, afterMakeup: dto.afterMakeup };
  }

  /** Withdraws an override, letting the engine's verdict stand again. */
  async clearDecisionOverride(
    enrollmentId: string,
    afterMakeup: boolean,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{ cleared: boolean }> {
    await this.writableEnrollment(enrollmentId, viewer);

    const { count } = await this.prisma.promotion_overrides.deleteMany({
      where: { enrollment_id: enrollmentId, after_makeup: afterMakeup },
    });
    if (count === 0) {
      return { cleared: false };
    }

    await this.audit.record(actor, {
      action: 'promotion.decision.override.clear',
      entityType: 'enrollment',
      entityId: enrollmentId,
      after: { afterMakeup },
    });
    return { cleared: true };
  }

  /**
   * §8 Phase 4: "promotion run (preview → confirm → **next year's enrollments
   * + carried subjects**)". All three parts happen here, in one transaction.
   *
   * The caller names the enrolments rather than re-selecting them, so a row
   * that appeared in the preview but was excluded by the head teacher stays
   * excluded, and a row created since the preview is not swept in unreviewed.
   *
   * **Why next year's enrolment has to be created here, not later.** A
   * `carried_subjects` row means "this enrolment is carrying a subject it owes
   * from an earlier one" — `enrollment_id` is the *new* year, and
   * `from_enrollment_id` is where the subject was failed. The DDL enforces
   * exactly that with `CHECK (enrollment_id <> from_enrollment_id)`, so a
   * carry cannot be recorded against the enrolment that produced it. Writing
   * the decision without the forward enrolment would leave the carry with
   * nowhere to attach.
   *
   * `targetSections` maps a level id to the section next year's enrolment goes
   * into. A student whose level has no mapping is decided but not moved
   * forward — the head teacher may not have opened next year's sections yet,
   * and inventing one would put a student on a roster nobody chose.
   */
  async confirm(
    dto: ConfirmPromotionDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<{
    applied: number;
    enrollmentsCreated: number;
    carriesWritten: number;
    notMovedForward: number;
  }> {
    /* Replays the scoped preview, so an enrolment the viewer may not reach is
       never in `previewed` — and the length check below then refuses the whole
       run rather than quietly applying the subset they were allowed. That is
       what re-verifies the ids a caller supplied, and it is why `confirm` needs
       no scope check of its own. */
    const previewed = await this.preview(dto, viewer);
    const selected = previewed.filter((row) =>
      dto.enrollmentIds.includes(row.enrollmentId),
    );

    const blocked = selected.filter((row) => row.blocker !== null);
    if (blocked.length > 0) {
      throw new ConflictException(
        `${blocked.length} of the selected enrolments cannot be decided: ${blocked[0].blocker}`,
      );
    }
    if (selected.length !== dto.enrollmentIds.length) {
      throw new BadRequestException(
        'Some of the named enrolments are not in this promotion run; re-run the preview',
      );
    }

    const targetSections = await this.loadTargetSections(dto);

    let enrollmentsCreated = 0;
    let carriesWritten = 0;
    let notMovedForward = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const row of selected) {
        await tx.enrollments.update({
          where: { id: row.enrollmentId },
          data: {
            final_decision: row.decision,
            decided_at: new Date(),
            decided_by: actor.userId,
            // A student sent to a makeup is not finished with the year yet.
            status: row.decision === 'makeup_required' ? 'active' : 'completed',
          },
        });

        // A makeup is still this year's business, and a graduate has no next
        // level to go to.
        if (row.decision === 'makeup_required' || row.decision === 'graduate') {
          continue;
        }

        const target = targetSections.get(row.enrollmentId);
        if (!target) {
          notMovedForward += 1;
          continue;
        }

        const next = await tx.enrollments.upsert({
          // enrollments is UNIQUE (student_id, academic_year_id), so re-running
          // a confirmed promotion reuses next year's row rather than failing.
          where: {
            student_id_academic_year_id: {
              student_id: row.studentId,
              academic_year_id: target.academic_year_id,
            },
          },
          create: {
            student_id: row.studentId,
            section_id: target.id,
            academic_year_id: target.academic_year_id,
            branch_id: target.branch_id,
            gender: target.gender,
            entry_type: entryTypeFor(row.decision),
            created_by: actor.userId,
          },
          update: {},
        });
        if (next.created_at.getTime() > Date.now() - 60_000) {
          enrollmentsCreated += 1;
        }

        // §4.3: "promote_with_carry writes one carried_subjects row per
        // still-failed subject with from_enrollment_id and origin_level_id."
        if (row.decision === 'promote_with_carry') {
          for (const subject of row.failedSubjects) {
            await tx.carried_subjects.upsert({
              where: {
                enrollment_id_subject_id_origin_level_id: {
                  enrollment_id: next.id,
                  subject_id: subject.subjectId,
                  origin_level_id: row.levelId,
                },
              },
              create: {
                enrollment_id: next.id,
                from_enrollment_id: row.enrollmentId,
                subject_id: subject.subjectId,
                origin_level_id: row.levelId,
              },
              update: {},
            });
            carriesWritten += 1;
          }
        }
      }
    });

    await this.audit.record(actor, {
      action: 'promotion.confirm',
      entityType: 'academic_year',
      entityId: String(dto.academicYearId),
      after: {
        applied: selected.length,
        enrollmentsCreated,
        carriesWritten,
        notMovedForward,
        afterMakeup: dto.afterMakeup,
        decisions: selected.map((row) => ({
          enrollmentId: row.enrollmentId,
          decision: row.decision,
        })),
      },
    });
    return {
      applied: selected.length,
      enrollmentsCreated,
      carriesWritten,
      notMovedForward,
    };
  }

  /**
   * Resolves, per selected enrolment, the section next year's enrolment goes
   * into: the level after this one, in the target year, matching the student's
   * gender and branch (R3 — a roster cannot mix).
   *
   * Levels advance by `sort_order`, which R1 fixes, so "the next level" is a
   * lookup rather than a hardcoded chain. A repeat stays at the same level.
   */
  private async loadTargetSections(
    dto: ConfirmPromotionDto,
  ): Promise<Map<string, TargetSection>> {
    const targets = new Map<string, TargetSection>();
    if (dto.targetAcademicYearId === undefined) {
      return targets;
    }

    const [levels, sections, enrollments] = await Promise.all([
      this.prisma.levels.findMany({ orderBy: { sort_order: 'asc' } }),
      this.prisma.sections.findMany({
        where: { academic_year_id: dto.targetAcademicYearId },
      }),
      this.prisma.enrollments.findMany({
        where: { id: { in: dto.enrollmentIds } },
        include: { section: { select: { level_id: true } } },
      }),
    ]);

    const levelBySortOrder = new Map(
      levels.map((level) => [level.sort_order, level]),
    );

    for (const enrollment of enrollments) {
      const current = levels.find(
        (level) => level.id === enrollment.section.level_id,
      );
      if (!current) continue;

      // A repeat stays put; everything else advances one level. COMP is never
      // reached automatically — R20 makes it a gate on enrolment, chosen by
      // the student, so it is excluded from the automatic next step.
      const nextLevel =
        levelBySortOrder.get(current.sort_order + 1) ?? undefined;
      const wanted =
        nextLevel && !nextLevel.requires_clean_entry ? nextLevel : current;

      const section = sections.find(
        (candidate) =>
          candidate.level_id === wanted.id &&
          candidate.gender === enrollment.gender &&
          candidate.branch_id === enrollment.branch_id,
      );
      if (section) {
        targets.set(enrollment.id, section);
      }
    }
    return targets;
  }

  /**
   * R20 / §4.4 — the COMP entry gate.
   *
   * A gate on *enrolment*: nothing here enrols anyone, because COMP is
   * elective and student-chosen. It answers whether an enrolment the head
   * teacher is attempting is allowed, and says which condition failed.
   */
  async checkCompEligibility(
    studentId: string,
    viewer: AuthenticatedUser,
  ): Promise<{
    allowed: boolean;
    refusal: string | null;
    pendingCarries: Array<{
      subjectId: number;
      nameAr: string;
      levelId: number;
    }>;
  }> {
    // F1: GET /students/:id/comp-eligibility leaked another branch's carry list.
    await this.assertStudentVisible(studentId, viewer);

    const latestL4 = await this.prisma.enrollments.findFirst({
      where: {
        student_id: studentId,
        section: { levels: { is_terminal: true } },
      },
      orderBy: { created_at: 'desc' },
      select: { final_decision: true },
    });

    // §4.6: carries survive more than one promotion, so every prior enrolment
    // is scanned, not just the most recent.
    const carries = await this.prisma.carried_subjects.findMany({
      where: {
        status: 'pending',
        enrollments_carried_subjects_enrollment_idToenrollments: {
          student_id: studentId,
        },
      },
      include: { subjects: { select: { name_ar: true } } },
    });

    const verdict = checkCompEntry({
      latestL4Decision: latestL4?.final_decision ?? null,
      pendingCarryCount: carries.length,
    });

    return {
      allowed: verdict.allowed,
      refusal: verdict.refusal,
      pendingCarries: carries.map((carry) => ({
        subjectId: carry.subject_id,
        nameAr: carry.subjects.name_ar,
        levelId: carry.origin_level_id,
      })),
    };
  }

  /**
   * §4.5: "The natural UI is a 'ready to certify' list per level: students
   * whose enrollment reached promote or graduate with no certificate yet."
   */
  async listCertifiable(
    viewer: AuthenticatedUser,
    levelId?: number,
  ): Promise<CertifiableStudent[]> {
    const enrollments = await this.prisma.enrollments.findMany({
      where: {
        ...branchScope(viewer.branchId),
        final_decision: { in: ['promote', 'graduate'] },
        section: {
          levels: {
            grants_certificate: true,
            ...(levelId ? { id: levelId } : {}),
          },
        },
      },
      include: {
        student: { select: { full_name: true } },
        section: { include: { levels: true } },
      },
      orderBy: { student: { full_name: 'asc' } },
    });

    // Only LIVE certificates take a student off the list. A revoked one is
    // history — the student is owed a certificate again, and the partial
    // unique index lets them have one. One lookup rather than a per-row query.
    const issued = await this.prisma.certificates.findMany({
      where: { revoked_at: null },
      select: { student_id: true, level_id: true },
    });
    const issuedKeys = new Set(
      issued.map((row) => `${row.student_id}:${row.level_id}`),
    );

    return enrollments
      .filter(
        (enrollment) =>
          !issuedKeys.has(
            `${enrollment.student_id}:${enrollment.section.levels.id}`,
          ),
      )
      .map((enrollment) => ({
        studentId: enrollment.student_id,
        studentName: enrollment.student.full_name,
        enrollmentId: enrollment.id,
        levelId: enrollment.section.levels.id,
        levelCode: enrollment.section.levels.code,
        decision: enrollment.final_decision as string,
      }));
  }

  /**
   * R19 — every level grants a certificate, issued by the head teacher.
   * §4.5: "Issuance is a deliberate act, not a side effect of passing."
   *
   * A student who previously held a certificate that was **revoked** may be
   * issued a new one: the partial unique index counts only live certificates,
   * so the revoked row stays as history without blocking the replacement.
   * Losing the printed paper is a different case entirely and does not come
   * here — see `reprintCertificate`, which reuses the existing certificate
   * rather than minting a second one for the same achievement.
   */
  async issueCertificate(
    dto: IssueCertificateDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<CertificateView> {
    await this.assertStudentVisible(dto.studentId, viewer);
    const level = await this.prisma.levels.findUniqueOrThrow({
      where: { id: dto.levelId },
    });
    if (!level.grants_certificate) {
      throw new ConflictException(
        `Level ${level.code} does not grant a certificate`,
      );
    }

    // A live certificate already covering this level is not a case for a
    // second one — it is almost always someone trying to reprint. Say so,
    // and name the endpoint that actually does that.
    const live = await this.prisma.certificates.findFirst({
      where: {
        student_id: dto.studentId,
        level_id: dto.levelId,
        revoked_at: null,
      },
      select: { id: true, serial_no: true },
    });
    if (live) {
      throw new ConflictException(
        `This student already holds a certificate for ${level.code}${
          live.serial_no ? ` (serial ${live.serial_no})` : ''
        }. To print another copy use the reprint action; to replace it, revoke it first.`,
      );
    }

    const enrollment = await this.prisma.enrollments.findFirst({
      where: {
        student_id: dto.studentId,
        section: { level_id: dto.levelId },
        final_decision: { in: ['promote', 'graduate'] },
      },
      select: { id: true, academic_year_id: true, branch_id: true },
    });
    if (!enrollment) {
      throw new ConflictException(
        'This student has no completed enrolment at that level to certify',
      );
    }

    const serialNo =
      dto.serialNo ??
      (await this.nextSerialNo(level.code, enrollment.academic_year_id));

    const created = await this.prisma.certificates.create({
      data: {
        student_id: dto.studentId,
        level_id: dto.levelId,
        enrollment_id: dto.enrollmentId ?? enrollment.id,
        academic_year_id: enrollment.academic_year_id,
        branch_id: enrollment.branch_id,
        serial_no: serialNo,
        issued_by: actor.userId,
        notes: dto.notes,
      },
      include: {
        students: { select: { full_name: true } },
        levels: { select: { code: true } },
      },
    });

    await this.audit.record(actor, {
      action: 'certificate.issue',
      entityType: 'certificate',
      entityId: created.id,
      after: {
        studentId: dto.studentId,
        levelId: dto.levelId,
        serialNo,
        replacesRevoked: await this.hasRevokedCertificate(
          dto.studentId,
          dto.levelId,
        ),
      },
    });
    return toCertificateView(created);
  }

  /**
   * Everything needed to print a certificate, plus a record that it was
   * printed.
   *
   * A lost or damaged paper does **not** mean a new certificate: the
   * achievement is unchanged, so the serial, the issue date and the issuing
   * head teacher all stay as they were. Only the fact that another copy now
   * exists is new, and that goes in the audit log — which is what lets the
   * institute answer "how many copies of this are out there" later.
   *
   * §10 item 2 leaves the printed wording open, so this returns the facts a
   * certificate is made of and leaves the layout to whoever renders it.
   */
  async reprintCertificate(
    certificateId: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<CertificatePrintPayload> {
    const certificate = await this.prisma.certificates.findUniqueOrThrow({
      where: { id: certificateId },
      include: {
        students: { select: { full_name: true, student_code: true } },
        levels: { select: { code: true, name_ar: true } },
        academic_years: { select: { hijri_year: true } },
        branches: { select: { name_ar: true } },
        users_certificates_issued_byTousers: { select: { full_name: true } },
      },
    });
    this.assertCertificateBranchVisible(certificate.branch_id, viewer);

    if (certificate.revoked_at) {
      throw new ConflictException(
        `This certificate was revoked (${certificate.revoke_reason ?? 'no reason recorded'}) and must not be printed. Issue a new one instead.`,
      );
    }

    const settings = await this.prisma.institute_settings.findUniqueOrThrow({
      where: { id: 1 },
    });

    // Counting prior reprints from the audit log rather than a column: the
    // log already records who printed each copy and when, which is the part
    // that matters, and a counter would duplicate it while answering less.
    const previousPrints = await this.prisma.audit_logs.count({
      where: {
        action: 'certificate.reprint',
        entity_type: 'certificate',
        entity_id: certificateId,
      },
    });

    await this.audit.record(actor, {
      action: 'certificate.reprint',
      entityType: 'certificate',
      entityId: certificateId,
      after: {
        serialNo: certificate.serial_no,
        copyNumber: previousPrints + 2, // the original print is copy 1
      },
    });

    return {
      certificateId: certificate.id,
      serialNo: certificate.serial_no,
      studentName: certificate.students.full_name,
      studentCode: certificate.students.student_code,
      levelCode: certificate.levels.code,
      levelNameAr: certificate.levels.name_ar,
      instituteNameAr: settings.name_ar,
      branchNameAr: certificate.branches?.name_ar ?? null,
      hijriYear: certificate.academic_years?.hijri_year ?? null,
      issuedAt: certificate.issued_at.toISOString(),
      issuedByName: certificate.users_certificates_issued_byTousers.full_name,
      // 1 is the original issue; every reprint after that is a further copy.
      copyNumber: previousPrints + 2,
      notes: certificate.notes,
    };
  }

  /**
   * §10 item 2 leaves the numbering to the institute, so this is a default the
   * head teacher can always override by passing `serialNo`. Shaped
   * `L1-1447-0001`: level, Hijri year, then a sequence within that pair, which
   * sorts correctly and is readable off a printed page.
   *
   * `serial_no` is UNIQUE across the whole table, so the sequence is derived
   * from the highest existing serial with the same prefix — a revoked
   * certificate keeps its number, and the replacement gets the next one.
   */
  private async nextSerialNo(
    levelCode: string,
    academicYearId: number,
  ): Promise<string> {
    const year = await this.prisma.academic_years.findUnique({
      where: { id: academicYearId },
      select: { hijri_year: true },
    });
    const prefix = `${levelCode}-${year?.hijri_year ?? 'X'}-`;

    const latest = await this.prisma.certificates.findFirst({
      where: { serial_no: { startsWith: prefix } },
      orderBy: { serial_no: 'desc' },
      select: { serial_no: true },
    });
    const lastSequence = Number.parseInt(
      latest?.serial_no?.slice(prefix.length) ?? '0',
      10,
    );
    const next = Number.isNaN(lastSequence) ? 1 : lastSequence + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  private async hasRevokedCertificate(
    studentId: string,
    levelId: number,
  ): Promise<boolean> {
    const revoked = await this.prisma.certificates.count({
      where: {
        student_id: studentId,
        level_id: levelId,
        revoked_at: { not: null },
      },
    });
    return revoked > 0;
  }

  /** §4.5: "Revocation requires a reason and is audited." */
  async revokeCertificate(
    certificateId: string,
    reason: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<CertificateView> {
    const existing = await this.prisma.certificates.findUniqueOrThrow({
      where: { id: certificateId },
      select: { branch_id: true },
    });
    this.assertCertificateBranchVisible(existing.branch_id, viewer);
    const updated = await this.prisma.certificates.update({
      where: { id: certificateId },
      data: {
        revoked_at: new Date(),
        revoked_by: actor.userId,
        revoke_reason: reason,
      },
      include: {
        students: { select: { full_name: true } },
        levels: { select: { code: true } },
      },
    });
    await this.audit.record(actor, {
      action: 'certificate.revoke',
      entityType: 'certificate',
      entityId: certificateId,
      after: { reason },
    });
    return toCertificateView(updated);
  }

  async listCertificates(
    viewer: AuthenticatedUser,
    studentId?: string,
  ): Promise<CertificateView[]> {
    const rows = await this.prisma.certificates.findMany({
      where: {
        // F1: GET /certificates listed every branch's certificates.
        ...branchScope(viewer.branchId),
        ...(studentId ? { student_id: studentId } : {}),
      },
      include: {
        students: { select: { full_name: true } },
        levels: { select: { code: true } },
      },
      orderBy: { issued_at: 'desc' },
    });
    return rows.map(toCertificateView);
  }

  /** Refuses if the student is outside the viewer's branch (F1). NotFound so a
   * teacher cannot probe for students in other branches. */
  private async assertStudentVisible(
    studentId: string,
    viewer: AuthenticatedUser,
  ): Promise<void> {
    const student = await this.prisma.students.findUnique({
      where: { id: studentId },
      select: { branch_id: true, deleted_at: true },
    });
    // Mirrors StudentsService.findVisible: a branch-bound viewer sees only
    // students in their own branch (an unassigned, null-branch student
    // included, is not theirs).
    if (
      !student ||
      student.deleted_at ||
      (viewer.branchId !== null && student.branch_id !== viewer.branchId)
    ) {
      throw new NotFoundException('Student not found');
    }
  }

  /** A certificate with no branch is institute-wide and only an institute-wide
   * viewer may touch it; otherwise the branches must match (F1). */
  private assertCertificateBranchVisible(
    branchId: number | null,
    viewer: AuthenticatedUser,
  ): void {
    const visible =
      branchId === null
        ? viewer.branchId === null
        : canAccessBranch(viewer, branchId);
    if (!visible) {
      throw new NotFoundException('Certificate not found');
    }
  }
}

/**
 * §5 entry_type_t records *how* a student arrived at a level, which is what
 * §4.6 later reads to label them a repeater or a carrier on the eligibility
 * lists.
 */
function entryTypeFor(
  decision: PromotionDecision,
): 'promoted' | 'promoted_with_carry' | 'repeater' {
  if (decision === 'promote_with_carry') return 'promoted_with_carry';
  if (decision === 'repeat') return 'repeater';
  return 'promoted';
}

function toCertificateView(row: {
  id: string;
  student_id: string;
  students: { full_name: string };
  level_id: number;
  levels: { code: string };
  serial_no: string | null;
  issued_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}): CertificateView {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.students.full_name,
    levelId: row.level_id,
    levelCode: row.levels.code,
    serialNo: row.serial_no,
    issuedAt: row.issued_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokeReason: row.revoke_reason,
  };
}
