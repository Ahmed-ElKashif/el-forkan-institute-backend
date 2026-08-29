import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { canAccessSection } from '../common/access-scope';
import { AuditService } from '../common/audit.service';
import { withConcurrency } from '../common/concurrency';
import { toDateOnlyString } from '../common/date-only.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { renderTemplate, toWhatsAppRecipient } from './message-rendering';
import { WhatsAppClient } from './whatsapp.client';

/**
 * §7.7 — "No queue — safely".
 *
 * Two guards stand in for a queue, and both live in the database rather than
 * in memory, so a restart, a redeploy or a double cron cannot double-send:
 *
 * - `message_campaigns` is UNIQUE `(template_id, section_id, target_date)`.
 *   Claiming that row IS the lock. A second attempt for the same section and
 *   day collides on insert.
 * - `job_runs` is UNIQUE `(job_name, run_key)`, claimed transactionally
 *   *before* any work begins, so two instances racing the same nightly sweep
 *   settle it in Postgres.
 */

// §7.7: "Send with p-limit (~5 concurrent)".
const SEND_CONCURRENCY = 5;

// §6.4: "the WhatsApp reminder should stay off per section until coverage is
// adequate." Below this, the campaign refuses and says so — sending to a
// third of a class silently is worse than not sending.
const MIN_PHONE_COVERAGE_PERCENT = 70;

export interface CampaignView {
  id: string;
  templateCode: string;
  sectionId: string | null;
  sectionName: string | null;
  targetDate: string | null;
  status: string;
  sentAt: string | null;
  counts: { queued: number; sent: number; failed: number; delivered: number };
}

export interface SendOutcome {
  campaignId: string;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly whatsapp: WhatsAppClient,
  ) {}

  /**
   * Builds the Friday reminder for one section and queues one `messages` row
   * per student (R10: "to every student ... regardless of onsite/online").
   *
   * Queuing and sending are separate steps on purpose: the rows exist, with
   * their rendered bodies, before anything leaves the building. That is what
   * makes a failed send retryable and an audit answerable.
   */
  async queueFridayReminder(
    sectionId: string,
    targetDate: Date,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<CampaignView> {
    const section = await this.loadAccessibleSection(sectionId, viewer);
    const template = await this.prisma.message_templates.findUniqueOrThrow({
      where: { code: 'friday_schedule' },
    });

    const coverage = await this.phoneCoverage(sectionId);
    if (coverage.percentage < MIN_PHONE_COVERAGE_PERCENT) {
      throw new ConflictException(
        `Only ${coverage.withPhone} of ${coverage.total} students in this section have a number (${coverage.percentage}%). Fill in the missing numbers before sending.`,
      );
    }

    // The unique constraint is the idempotency mechanism, so the insert is
    // attempted rather than preceded by a "does it exist" check that would be
    // racy between two cron ticks.
    let campaign: { id: string };
    try {
      campaign = await this.prisma.message_campaigns.create({
        data: {
          template_id: template.id,
          section_id: sectionId,
          target_date: targetDate,
          created_by: actor.userId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A reminder for this section and date already exists',
        );
      }
      throw error;
    }

    const sessions = await this.prisma.sessions.findMany({
      where: { section_id: sectionId, session_date: targetDate },
      include: { subjects: { select: { name_ar: true } } },
      orderBy: { starts_at: 'asc' },
    });
    const schedule = sessions
      .filter((session) => session.status !== 'cancelled')
      .map(
        (session) =>
          `${session.subjects.name_ar} ${session.starts_at.toISOString().slice(11, 16)}`,
      )
      .join('\n');

    const recipients = await this.prisma.enrollments.findMany({
      where: {
        section_id: sectionId,
        status: 'active',
        // R10 sends to every student, but a student who opted out is not a
        // recipient — and a student with no number cannot be one.
        student: {
          whatsapp_opt_in: true,
          OR: [{ phone: { not: null } }, { whatsapp_phone: { not: null } }],
        },
      },
      include: {
        student: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            whatsapp_phone: true,
          },
        },
      },
    });

    const rows: Prisma.messagesCreateManyInput[] = [];
    for (const enrollment of recipients) {
      const phone =
        enrollment.student.whatsapp_phone ?? enrollment.student.phone;
      if (!phone) continue;

      const { body, missing } = renderTemplate(template.body, {
        student_name: enrollment.student.full_name,
        date: toDateOnlyString(targetDate),
        schedule: schedule || 'لا توجد محاضرات',
      });
      if (missing.length > 0) {
        // A half-rendered reminder must never reach a student.
        this.logger.error(
          `Template ${template.code} is missing ${missing.join(', ')}; skipping ${enrollment.student.id}`,
        );
        continue;
      }

      rows.push({
        campaign_id: campaign.id,
        student_id: enrollment.student.id,
        phone,
        // §5.1: rendered_body is "evidence of what was sent".
        rendered_body: body,
        status: 'queued',
      });
    }
    await this.prisma.messages.createMany({ data: rows });

    await this.audit.record(actor, {
      action: 'campaign.queue',
      entityType: 'message_campaign',
      entityId: campaign.id,
      after: {
        sectionName: section.name,
        targetDate: toDateOnlyString(targetDate),
        queued: rows.length,
        coverage: coverage.percentage,
      },
    });
    return this.getCampaign(campaign.id);
  }

  /**
   * Sends everything still queued (or previously failed) on a campaign.
   *
   * Retries only `failed` rows, never `sent` ones (§7.7) — the per-message
   * status is what makes a second run safe. Re-running after a partial outage
   * therefore picks up exactly the students who did not get their reminder.
   */
  async send(campaignId: string, actor: Actor): Promise<SendOutcome> {
    const campaign = await this.prisma.message_campaigns.findUniqueOrThrow({
      where: { id: campaignId },
      include: { message_templates: true },
    });
    const settings = await this.prisma.institute_settings.findUniqueOrThrow({
      where: { id: 1 },
    });

    const pending = await this.prisma.messages.findMany({
      where: { campaign_id: campaignId, status: { in: ['queued', 'failed'] } },
    });
    if (pending.length === 0) {
      return {
        campaignId,
        attempted: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
      };
    }

    if (!this.whatsapp.isConfigured(settings.whatsapp_phone_number_id)) {
      // §7.8: Meta approval "takes days", and this is the only external
      // dependency with a lead time. Everything up to the send works without
      // it; the rows stay queued rather than being marked failed, so nothing
      // has to be un-failed once approval lands.
      throw new ConflictException(
        'WhatsApp is not configured yet: set whatsappPhoneNumberId in institute settings and WHATSAPP_ACCESS_TOKEN in the environment',
      );
    }
    const phoneNumberId = settings.whatsapp_phone_number_id as string;
    const templateName =
      campaign.message_templates.provider_template_name ??
      campaign.message_templates.code;

    const results = await withConcurrency(
      pending,
      SEND_CONCURRENCY,
      async (message) => {
        const result = await this.whatsapp.sendTemplate(phoneNumberId, {
          to: toWhatsAppRecipient(message.phone),
          templateName,
          languageCode: campaign.message_templates.language,
          bodyParameters: [message.rendered_body ?? ''],
        });

        await this.prisma.messages.update({
          where: { id: message.id },
          data: {
            status: result.status,
            provider_message_id: result.providerMessageId,
            error_code: result.errorCode,
            error_message: result.errorMessage,
            attempts: { increment: 1 },
            sent_at: result.status === 'sent' ? new Date() : null,
          },
        });
        return result.status;
      },
    );

    const sent = results.filter(
      (r) => r.status === 'fulfilled' && r.value === 'sent',
    ).length;
    const failed = results.length - sent;

    await this.prisma.message_campaigns.update({
      where: { id: campaignId },
      data: {
        status: failed === 0 ? 'completed' : 'failed',
        sent_at: new Date(),
      },
    });

    await this.audit.record(actor, {
      action: 'campaign.send',
      entityType: 'message_campaign',
      entityId: campaignId,
      after: { attempted: pending.length, sent, failed },
    });
    return { campaignId, attempted: pending.length, sent, failed, skipped: 0 };
  }

  async getCampaign(campaignId: string): Promise<CampaignView> {
    const campaign = await this.prisma.message_campaigns.findUnique({
      where: { id: campaignId },
      include: {
        message_templates: { select: { code: true } },
        sections: { select: { name: true } },
      },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    const grouped = await this.prisma.messages.groupBy({
      by: ['status'],
      where: { campaign_id: campaignId },
      _count: { _all: true },
    });
    const counts = { queued: 0, sent: 0, failed: 0, delivered: 0 };
    for (const group of grouped) {
      if (group.status in counts) {
        counts[group.status as keyof typeof counts] = group._count._all;
      }
    }

    return {
      id: campaign.id,
      templateCode: campaign.message_templates.code,
      sectionId: campaign.section_id,
      sectionName: campaign.sections?.name ?? null,
      targetDate: campaign.target_date
        ? toDateOnlyString(campaign.target_date)
        : null,
      status: campaign.status,
      sentAt: campaign.sent_at?.toISOString() ?? null,
      counts,
    };
  }

  async listCampaigns(viewer: AuthenticatedUser): Promise<CampaignView[]> {
    const campaigns = await this.prisma.message_campaigns.findMany({
      // §3: a teacher may "Trigger / view WhatsApp sends" for their own
      // section only.
      where:
        viewer.role === 'head_teacher'
          ? {}
          : {
              sections: { section_teachers: { some: { user_id: viewer.id } } },
            },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: { id: true },
    });
    return Promise.all(
      campaigns.map((campaign) => this.getCampaign(campaign.id)),
    );
  }

  /**
   * §4.8 — delivers the absence warnings the attendance save recorded.
   *
   * `attendance_warnings` rows with `message_id IS NULL` are the backlog: the
   * threshold was crossed and the student has not been told. Linking the
   * message back onto the warning is what stops the next sweep re-sending it,
   * and the unique `(enrollment, term, threshold)` is what stopped a duplicate
   * warning being recorded in the first place — "re-runs can never spam a
   * student".
   *
   * These are single messages, not a campaign: they are not a section-wide
   * send on a target date, so there is no `message_campaigns` row for them and
   * `messages.campaign_id` is nullable for exactly this case.
   */
  async notifyPendingAbsenceWarnings(): Promise<{
    sent: number;
    failed: number;
    skipped: number;
  }> {
    const settings = await this.prisma.institute_settings.findUniqueOrThrow({
      where: { id: 1 },
    });
    const template = await this.prisma.message_templates.findUnique({
      where: { code: 'absence_warning' },
    });
    if (!template?.is_active) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    const pending = await this.prisma.attendance_warnings.findMany({
      where: { message_id: null },
      include: {
        enrollments: {
          include: {
            section: { select: { level_id: true, academic_year_id: true } },
            student: {
              select: {
                id: true,
                full_name: true,
                phone: true,
                whatsapp_phone: true,
                whatsapp_opt_in: true,
              },
            },
          },
        },
      },
      take: 200,
    });
    if (pending.length === 0) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    const policies = await this.prisma.attendance_policies.findMany();
    const configured = this.whatsapp.isConfigured(
      settings.whatsapp_phone_number_id,
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    const results = await withConcurrency(
      pending,
      SEND_CONCURRENCY,
      async (warning) => {
        const student = warning.enrollments.student;
        const phone = student.whatsapp_phone ?? student.phone;
        if (!phone || !student.whatsapp_opt_in) {
          return 'skipped' as const;
        }

        const policy = policies.find(
          (row) =>
            row.academic_year_id ===
              warning.enrollments.section.academic_year_id &&
            (row.level_id === warning.enrollments.section.level_id ||
              row.level_id === null),
        );
        const { body, missing } = renderTemplate(template.body, {
          student_name: student.full_name,
          count: String(warning.absence_count),
          max: String(policy?.max_absences ?? warning.threshold),
        });
        if (missing.length > 0) {
          this.logger.error(
            `Template absence_warning is missing ${missing.join(', ')}; skipping ${student.id}`,
          );
          return 'skipped' as const;
        }

        // The row is written before the send so the message exists as evidence
        // even if the send fails, and the retry has something to update.
        const message = await this.prisma.messages.create({
          data: {
            student_id: student.id,
            phone,
            rendered_body: body,
            status: 'queued',
          },
        });
        await this.prisma.attendance_warnings.update({
          where: { id: warning.id },
          data: { message_id: message.id },
        });

        if (!configured) {
          // §7.8: Meta approval has a lead time. The warning is recorded and
          // linked; it stays queued until the integration is live.
          return 'skipped' as const;
        }

        const result = await this.whatsapp.sendTemplate(
          settings.whatsapp_phone_number_id as string,
          {
            to: toWhatsAppRecipient(phone),
            templateName: template.provider_template_name ?? template.code,
            languageCode: template.language,
            bodyParameters: [body],
          },
        );
        await this.prisma.messages.update({
          where: { id: message.id },
          data: {
            status: result.status,
            provider_message_id: result.providerMessageId,
            error_code: result.errorCode,
            error_message: result.errorMessage,
            attempts: { increment: 1 },
            sent_at: result.status === 'sent' ? new Date() : null,
          },
        });
        return result.status;
      },
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        failed += 1;
      } else if (result.value === 'sent') {
        sent += 1;
      } else if (result.value === 'failed') {
        failed += 1;
      } else {
        skipped += 1;
      }
    }
    return { sent, failed, skipped };
  }

  private async phoneCoverage(sectionId: string) {
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

  private async loadAccessibleSection(
    sectionId: string,
    viewer: AuthenticatedUser,
  ) {
    const section = await this.prisma.sections.findUnique({
      where: { id: sectionId },
      select: {
        name: true,
        branch_id: true,
        section_teachers: { select: { user_id: true } },
      },
    });
    if (!section) {
      throw new NotFoundException('Section not found');
    }
    if (!canAccessSection(viewer, section)) {
      throw new NotFoundException('Section not found');
    }
    return section;
  }
}
