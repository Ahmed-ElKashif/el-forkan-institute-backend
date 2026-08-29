import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { buildPage, Page, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ListAuditLogsQueryDto,
  UpdateInstituteSettingsDto,
  UpsertAttendancePolicyDto,
  UpsertProgressionRuleDto,
} from './dto/settings.schema';

const SETTINGS_ROW_ID = 1;

export interface ProgressionRuleView {
  id: number;
  academicYearId: number;
  levelId: number | null;
  maxCarriedSubjects: number;
  makeupRoundEnabled: boolean;
  carryForwardEnabled: boolean;
  mandatoryCanBeCarried: boolean;
  failureCountingUnit: string;
}

export interface AttendancePolicyView {
  id: number;
  academicYearId: number;
  levelId: number | null;
  maxAbsences: number;
  warnAtAbsences: number;
  autoWarnEnabled: boolean;
  exceedingAction: string;
}

export interface AuditLogView {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: string;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listProgressionRules(
    academicYearId: number,
  ): Promise<ProgressionRuleView[]> {
    const rows = await this.prisma.progression_rules.findMany({
      where: { academic_year_id: academicYearId },
      orderBy: [{ level_id: { sort: 'asc', nulls: 'first' } }],
    });
    return rows.map(toProgressionRule);
  }

  /**
   * Read-then-write rather than Prisma's `upsert`.
   *
   * `(academic_year_id, level_id)` is UNIQUE, but `level_id` is nullable and
   * Postgres treats NULLs as distinct inside a unique index — so the year-wide
   * fallback row (§4.3: "falling back to the year's level_id IS NULL row")
   * is neither protected by that constraint nor addressable through Prisma's
   * compound-unique `where`, which types `level_id` as non-null. An `upsert`
   * here would silently insert a second fallback row every time it was saved.
   * `findFirst` with `level_id: null` compiles to `IS NULL` and does match it.
   *
   * The read-then-write is not atomic; two head teachers saving the same rule
   * in the same instant could still race. That is acceptable for a settings
   * screen used by one person, and the unique index still catches the
   * per-level rows.
   */
  async upsertProgressionRule(
    academicYearId: number,
    dto: UpsertProgressionRuleDto,
    actor: Actor,
  ): Promise<ProgressionRuleView> {
    const before = await this.prisma.progression_rules.findFirst({
      where: { academic_year_id: academicYearId, level_id: dto.levelId },
    });

    const values = {
      max_carried_subjects: dto.maxCarriedSubjects,
      makeup_round_enabled: dto.makeupRoundEnabled,
      carry_forward_enabled: dto.carryForwardEnabled,
      mandatory_can_be_carried: dto.mandatoryCanBeCarried,
      failure_counting_unit: dto.failureCountingUnit,
      updated_by: actor.userId,
      updated_at: new Date(),
    };
    const saved = before
      ? await this.prisma.progression_rules.update({
          where: { id: before.id },
          data: values,
        })
      : await this.prisma.progression_rules.create({
          data: {
            academic_year_id: academicYearId,
            level_id: dto.levelId,
            ...values,
          },
        });

    await this.audit.record(actor, {
      action: 'progression_rule.upsert',
      entityType: 'progression_rule',
      entityId: String(saved.id),
      before: before && toProgressionRule(before),
      after: toProgressionRule(saved),
    });
    return toProgressionRule(saved);
  }

  async listAttendancePolicies(
    academicYearId: number,
  ): Promise<AttendancePolicyView[]> {
    const rows = await this.prisma.attendance_policies.findMany({
      where: { academic_year_id: academicYearId },
      orderBy: [{ level_id: { sort: 'asc', nulls: 'first' } }],
    });
    return rows.map(toAttendancePolicy);
  }

  async upsertAttendancePolicy(
    academicYearId: number,
    dto: UpsertAttendancePolicyDto,
    actor: Actor,
  ): Promise<AttendancePolicyView> {
    // Same nullable-level_id reasoning as upsertProgressionRule above.
    const before = await this.prisma.attendance_policies.findFirst({
      where: { academic_year_id: academicYearId, level_id: dto.levelId },
    });

    const values = {
      max_absences: dto.maxAbsences,
      warn_at_absences: dto.warnAtAbsences,
      auto_warn_enabled: dto.autoWarnEnabled,
      exceeding_action: dto.exceedingAction,
      updated_by: actor.userId,
      updated_at: new Date(),
    };
    const saved = before
      ? await this.prisma.attendance_policies.update({
          where: { id: before.id },
          data: values,
        })
      : await this.prisma.attendance_policies.create({
          data: {
            academic_year_id: academicYearId,
            level_id: dto.levelId,
            ...values,
          },
        });

    await this.audit.record(actor, {
      action: 'attendance_policy.upsert',
      entityType: 'attendance_policy',
      entityId: String(saved.id),
      before: before && toAttendancePolicy(before),
      after: toAttendancePolicy(saved),
    });
    return toAttendancePolicy(saved);
  }

  async getInstituteSettings() {
    return toSettings(
      await this.prisma.institute_settings.findUniqueOrThrow({
        where: { id: SETTINGS_ROW_ID },
      }),
    );
  }

  async updateInstituteSettings(dto: UpdateInstituteSettingsDto, actor: Actor) {
    const before = await this.prisma.institute_settings.findUniqueOrThrow({
      where: { id: SETTINGS_ROW_ID },
    });
    const updated = await this.prisma.institute_settings.update({
      where: { id: SETTINGS_ROW_ID },
      data: {
        name_ar: dto.nameAr,
        default_lecture_weekday: dto.defaultLectureWeekday,
        timezone: dto.timezone,
        year_start_hijri_month: dto.yearStartHijriMonth,
        year_start_hijri_day: dto.yearStartHijriDay,
        year_end_hijri_month: dto.yearEndHijriMonth,
        year_end_hijri_day: dto.yearEndHijriDay,
        sessions_per_term: dto.sessionsPerTerm,
        default_max_score: dto.defaultMaxScore,
        default_pass_score: dto.defaultPassScore,
        placement_default_max: dto.placementDefaultMax,
        placement_default_pass: dto.placementDefaultPass,
        reminder_weekday: dto.reminderWeekday,
        reminder_send_time: dto.reminderSendTime
          ? new Date(`1970-01-01T${dto.reminderSendTime}:00Z`)
          : undefined,
        whatsapp_business_phone: dto.whatsappBusinessPhone,
        whatsapp_phone_number_id: dto.whatsappPhoneNumberId,
        whatsapp_owner_user_id: dto.whatsappOwnerUserId,
        updated_by: actor.userId,
        updated_at: new Date(),
      },
    });

    await this.audit.record(actor, {
      action: 'institute_settings.update',
      entityType: 'institute_settings',
      entityId: String(SETTINGS_ROW_ID),
      before: toSettings(before),
      after: toSettings(updated),
    });
    return toSettings(updated);
  }

  async listAuditLogs(
    query: ListAuditLogsQueryDto,
  ): Promise<Page<AuditLogView>> {
    const where: Prisma.audit_logsWhereInput = {
      ...(query.entityType ? { entity_type: query.entityType } : {}),
      ...(query.entityId ? { entity_id: query.entityId } : {}),
      ...(query.actorId ? { actor_id: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.audit_logs.findMany({
        where,
        include: { users: { select: { full_name: true } } },
        orderBy: { created_at: 'desc' },
        ...toPrismaPage(query),
      }),
      this.prisma.audit_logs.count({ where }),
    ]);
    return buildPage(rows.map(toAuditLog), total, query);
  }
}

function toProgressionRule(row: {
  id: number;
  academic_year_id: number;
  level_id: number | null;
  max_carried_subjects: number;
  makeup_round_enabled: boolean;
  carry_forward_enabled: boolean;
  mandatory_can_be_carried: boolean;
  failure_counting_unit: string;
}): ProgressionRuleView {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    levelId: row.level_id,
    maxCarriedSubjects: row.max_carried_subjects,
    makeupRoundEnabled: row.makeup_round_enabled,
    carryForwardEnabled: row.carry_forward_enabled,
    mandatoryCanBeCarried: row.mandatory_can_be_carried,
    failureCountingUnit: row.failure_counting_unit,
  };
}

function toAttendancePolicy(row: {
  id: number;
  academic_year_id: number;
  level_id: number | null;
  max_absences: number;
  warn_at_absences: number;
  auto_warn_enabled: boolean;
  exceeding_action: string;
}): AttendancePolicyView {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    levelId: row.level_id,
    maxAbsences: row.max_absences,
    warnAtAbsences: row.warn_at_absences,
    autoWarnEnabled: row.auto_warn_enabled,
    exceedingAction: row.exceeding_action,
  };
}

function toSettings(row: {
  name_ar: string;
  default_lecture_weekday: number;
  timezone: string;
  year_start_hijri_month: number;
  year_start_hijri_day: number;
  year_end_hijri_month: number;
  year_end_hijri_day: number;
  sessions_per_term: number;
  default_max_score: Prisma.Decimal;
  default_pass_score: Prisma.Decimal;
  placement_default_max: Prisma.Decimal;
  placement_default_pass: Prisma.Decimal;
  reminder_weekday: number;
  reminder_send_time: Date;
  whatsapp_business_phone: string | null;
  whatsapp_phone_number_id: string | null;
  whatsapp_owner_user_id: string | null;
}) {
  return {
    nameAr: row.name_ar,
    defaultLectureWeekday: row.default_lecture_weekday,
    timezone: row.timezone,
    yearStartHijriMonth: row.year_start_hijri_month,
    yearStartHijriDay: row.year_start_hijri_day,
    yearEndHijriMonth: row.year_end_hijri_month,
    yearEndHijriDay: row.year_end_hijri_day,
    sessionsPerTerm: row.sessions_per_term,
    defaultMaxScore: row.default_max_score.toNumber(),
    defaultPassScore: row.default_pass_score.toNumber(),
    placementDefaultMax: row.placement_default_max.toNumber(),
    placementDefaultPass: row.placement_default_pass.toNumber(),
    reminderWeekday: row.reminder_weekday,
    reminderSendTime: row.reminder_send_time.toISOString().slice(11, 16),
    whatsappBusinessPhone: row.whatsapp_business_phone,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    whatsappOwnerUserId: row.whatsapp_owner_user_id,
    // Deliberately absent: the WhatsApp access token is an env var and must
    // never be readable through the API (spec §7.8).
  };
}

function toAuditLog(row: {
  id: bigint;
  actor_id: string | null;
  users: { full_name: string } | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip_address: string | null;
  created_at: Date;
}): AuditLogView {
  return {
    // BIGSERIAL: JSON.stringify throws on a BigInt, so it crosses the wire as
    // a string rather than losing precision as a float.
    id: row.id.toString(),
    actorId: row.actor_id,
    actorName: row.users?.full_name ?? null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before,
    after: row.after,
    ipAddress: row.ip_address,
    createdAt: row.created_at.toISOString(),
  };
}
