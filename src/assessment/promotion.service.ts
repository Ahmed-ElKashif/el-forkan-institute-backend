import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { checkCompEntry } from '../rules/comp-gate';
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
  decision: PromotionDecision;
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
  async preview(dto: RunPromotionDto): Promise<PromotionPreviewRow[]> {
    const enrollments = await this.prisma.enrollments.findMany({
      where: {
        academic_year_id: dto.academicYearId,
        status: 'active',
        ...(dto.levelId ? { section: { level_id: dto.levelId } } : {}),
      },
      include: {
        student: { select: { full_name: true } },
        section: { include: { levels: true } },
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
      if (enrollment.is_historical) {
        return {
          ...base,
          failedSubjects: [],
          decision: 'repeat' as PromotionDecision,
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

      return {
        ...base,
        failedSubjects: failedRows.map((row) => ({
          subjectId: row.exams.curriculum.subject_id,
          nameAr: row.exams.curriculum.subjects.name_ar,
          isMandatory: row.exams.curriculum.is_mandatory,
        })),
        decision: dto.afterMakeup
          ? decideAfterMakeup(failed, levelRules, progressionRules)
          : decidePromotion(failed, levelRules, progressionRules),
        blocker: null,
      };
    });
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
  ): Promise<{
    applied: number;
    enrollmentsCreated: number;
    carriesWritten: number;
    notMovedForward: number;
  }> {
    const previewed = await this.preview(dto);
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
  async checkCompEligibility(studentId: string): Promise<{
    allowed: boolean;
    refusal: string | null;
    pendingCarries: Array<{
      subjectId: number;
      nameAr: string;
      levelId: number;
    }>;
  }> {
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
  async listCertifiable(levelId?: number): Promise<CertifiableStudent[]> {
    const enrollments = await this.prisma.enrollments.findMany({
      where: {
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
  ): Promise<CertificateView> {
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
  ): Promise<CertificateView> {
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

  async listCertificates(studentId?: string): Promise<CertificateView[]> {
    const rows = await this.prisma.certificates.findMany({
      where: studentId ? { student_id: studentId } : {},
      include: {
        students: { select: { full_name: true } },
        levels: { select: { code: true } },
      },
      orderBy: { issued_at: 'desc' },
    });
    return rows.map(toCertificateView);
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
