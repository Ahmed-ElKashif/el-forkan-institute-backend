import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { toDateOnlyString } from '../common/date-only.schema';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';

/**
 * R10 — "Thursday WhatsApp reminder to every student with the Friday schedule,
 * regardless of onsite/online."
 *
 * §7.7 replaces a queue with two database guards. This class owns the second
 * one: `job_runs` is UNIQUE `(job_name, run_key)` and the row is claimed
 * **before any work begins**, so two app instances (or a redeploy that
 * overlaps) settle the race in Postgres rather than both sending.
 */

const JOB_REMINDERS = 'thursday_reminders';
const JOB_ABSENCE_SWEEP = 'nightly_absence_sweep';

/**
 * Hourly, not "Thursday at 18:00". The institute's own reminder day and time
 * live in `institute_settings` (`reminder_weekday`, `reminder_send_time`) and
 * are head-teacher editable (R6's "All dates head-teacher editable" applies to
 * the calendar generally), so the cron wakes up often and the *settings*
 * decide whether this is the hour. A hardcoded cron expression would make
 * changing the time a redeploy.
 */
const HOURLY = '0 * * * *';
const NIGHTLY = '30 2 * * *';

@Injectable()
export class ReminderScheduler {
  private readonly logger = new Logger(ReminderScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  @Cron(HOURLY, { name: JOB_REMINDERS })
  async sendDueReminders(): Promise<void> {
    const settings = await this.prisma.institute_settings.findUnique({
      where: { id: 1 },
    });
    if (!settings) {
      return;
    }

    const now = new Date();
    const isoWeekday = now.getUTCDay() || 7;
    const sendHour = settings.reminder_send_time.getUTCHours();
    if (
      isoWeekday !== settings.reminder_weekday ||
      now.getUTCHours() !== sendHour
    ) {
      return;
    }

    // One claim per calendar day, so a restart within the same hour cannot
    // run it twice.
    const runKey = toDateOnlyString(now);
    if (!(await this.claim(JOB_REMINDERS, runKey))) {
      return;
    }

    try {
      const targetDate = nextDayUtc(now);
      const sections = await this.prisma.sections.findMany({
        where: {
          sessions: { some: { session_date: targetDate, status: 'scheduled' } },
        },
        select: { id: true, name: true },
      });

      const actor: Actor = { userId: settings.whatsapp_owner_user_id ?? '' };
      let queued = 0;
      for (const section of sections) {
        try {
          const campaign = await this.campaigns.queueFridayReminder(
            section.id,
            targetDate,
            actor,
            SYSTEM_VIEWER,
          );
          await this.campaigns.send(campaign.id, actor);
          queued += 1;
        } catch (error) {
          // One section's problem — a duplicate campaign, thin phone coverage,
          // WhatsApp not yet approved — must not stop the others.
          this.logger.warn(
            `Reminder for section ${section.name} skipped: ${describe(error)}`,
          );
        }
      }
      await this.finish(JOB_REMINDERS, runKey, 'completed', null);
      this.logger.log(
        `Thursday reminders: ${queued} of ${sections.length} sections sent for ${toDateOnlyString(targetDate)}`,
      );
    } catch (error) {
      await this.finish(JOB_REMINDERS, runKey, 'failed', describe(error));
      throw error;
    }
  }

  /**
   * §4.8 — "After each attendance save **and on a nightly sweep**: count term
   * absences → at `warn_at_absences` queue a WhatsApp warning."
   *
   * The save path already records thresholds as they are crossed; this catches
   * the cases a save cannot see — a policy the head teacher tightened after
   * the fact, or a term boundary moving.
   */
  @Cron(NIGHTLY, { name: JOB_ABSENCE_SWEEP })
  async sweepAbsenceWarnings(): Promise<void> {
    const runKey = toDateOnlyString(new Date());
    if (!(await this.claim(JOB_ABSENCE_SWEEP, runKey))) {
      return;
    }

    try {
      const notified = await this.campaigns.notifyPendingAbsenceWarnings();
      this.logger.log(
        `Absence sweep: ${notified.sent} sent, ${notified.failed} failed, ${notified.skipped} skipped`,
      );
      await this.finish(JOB_ABSENCE_SWEEP, runKey, 'completed', null);
    } catch (error) {
      await this.finish(JOB_ABSENCE_SWEEP, runKey, 'failed', describe(error));
      throw error;
    }
  }

  /**
   * §7.7: "`job_runs` with UNIQUE (job_name, run_key) claimed transactionally
   * before work begins."
   *
   * The insert IS the claim. Losing the race means the row already exists,
   * which is the correct answer — someone else is doing it.
   */
  private async claim(jobName: string, runKey: string): Promise<boolean> {
    try {
      await this.prisma.job_runs.create({
        data: { job_name: jobName, run_key: runKey, status: 'running' },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  private async finish(
    jobName: string,
    runKey: string,
    status: 'completed' | 'failed',
    error: string | null,
  ): Promise<void> {
    await this.prisma.job_runs.updateMany({
      where: { job_name: jobName, run_key: runKey },
      data: { status, finished_at: new Date(), error },
    });
  }
}

/**
 * The cron acts as the institute, not as a person: it has no branch and no
 * section assignments to be scoped by, and it must reach every section.
 */
const SYSTEM_VIEWER = {
  id: 'system',
  role: 'head_teacher',
  branchId: null,
} as const;

function nextDayUtc(from: Date): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
