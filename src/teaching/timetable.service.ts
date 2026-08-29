import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { canAccessSection } from '../common/access-scope';
import { AuditService } from '../common/audit.service';
import { toDateOnlyString } from '../common/date-only.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type {
  CreateTimetableSlotDto,
  GenerateSessionsDto,
  UpdateTimetableSlotDto,
} from './dto/teaching.schema';
import { findClashes, planSessions } from './session-planner';

export interface TimetableSlotView {
  id: string;
  sectionId: string;
  subjectId: number;
  subjectNameAr: string;
  teacherId: string | null;
  teacherName: string | null;
  weekday: number;
  slotOrder: number;
  startsAt: string;
  endsAt: string;
  room: string | null;
  mode: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

const SLOT_SHAPE = {
  include: {
    subjects: { select: { name_ar: true } },
    users_timetable_slots_teacher_idTousers: { select: { full_name: true } },
  },
} satisfies Prisma.timetable_slotsDefaultArgs;

type SlotRecord = Prisma.timetable_slotsGetPayload<typeof SLOT_SHAPE>;

@Injectable()
export class TimetableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    sectionId: string,
    viewer: AuthenticatedUser,
  ): Promise<TimetableSlotView[]> {
    await this.assertSectionAccess(sectionId, viewer);
    const rows = await this.prisma.timetable_slots.findMany({
      where: { section_id: sectionId },
      ...SLOT_SHAPE,
      orderBy: [{ weekday: 'asc' }, { slot_order: 'asc' }],
    });
    return rows.map(toSlotView);
  }

  async create(
    sectionId: string,
    dto: CreateTimetableSlotDto,
    actor: Actor,
  ): Promise<TimetableSlotView> {
    await this.assertNoTeacherClash(sectionId, null, {
      teacherId: dto.teacherId,
      weekday: dto.weekday,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
    });

    const created = await this.prisma.timetable_slots.create({
      data: {
        section_id: sectionId,
        subject_id: dto.subjectId,
        teacher_id: dto.teacherId,
        weekday: dto.weekday,
        slot_order: dto.slotOrder,
        starts_at: toTimeValue(dto.startsAt),
        ends_at: toTimeValue(dto.endsAt),
        room: dto.room,
        mode: dto.mode,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo,
        updated_by: actor.userId,
      },
      ...SLOT_SHAPE,
    });

    await this.audit.record(actor, {
      action: 'timetable.slot.create',
      entityType: 'section',
      entityId: sectionId,
      after: toSlotView(created),
    });
    return toSlotView(created);
  }

  async update(
    slotId: string,
    dto: UpdateTimetableSlotDto,
    actor: Actor,
  ): Promise<TimetableSlotView> {
    const before = await this.prisma.timetable_slots.findUniqueOrThrow({
      where: { id: slotId },
      ...SLOT_SHAPE,
    });

    await this.assertNoTeacherClash(before.section_id, slotId, {
      teacherId:
        dto.teacherId === undefined ? before.teacher_id : dto.teacherId,
      weekday: dto.weekday ?? before.weekday,
      startsAt: dto.startsAt ?? fromTimeValue(before.starts_at),
      endsAt: dto.endsAt ?? fromTimeValue(before.ends_at),
      effectiveFrom:
        dto.effectiveFrom === undefined
          ? before.effective_from
          : dto.effectiveFrom,
      effectiveTo:
        dto.effectiveTo === undefined ? before.effective_to : dto.effectiveTo,
    });

    const updated = await this.prisma.timetable_slots.update({
      where: { id: slotId },
      data: {
        teacher_id: dto.teacherId,
        weekday: dto.weekday,
        slot_order: dto.slotOrder,
        starts_at: dto.startsAt ? toTimeValue(dto.startsAt) : undefined,
        ends_at: dto.endsAt ? toTimeValue(dto.endsAt) : undefined,
        room: dto.room,
        mode: dto.mode,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo,
        updated_by: actor.userId,
      },
      ...SLOT_SHAPE,
    });

    await this.audit.record(actor, {
      action: 'timetable.slot.update',
      entityType: 'section',
      entityId: before.section_id,
      before: toSlotView(before),
      after: toSlotView(updated),
    });
    return toSlotView(updated);
  }

  async remove(slotId: string, actor: Actor): Promise<void> {
    const before = await this.prisma.timetable_slots.findUniqueOrThrow({
      where: { id: slotId },
      ...SLOT_SHAPE,
    });
    await this.prisma.timetable_slots.delete({ where: { id: slotId } });
    await this.audit.record(actor, {
      action: 'timetable.slot.delete',
      entityType: 'section',
      entityId: before.section_id,
      before: toSlotView(before),
    });
  }

  /**
   * Generates the term's sessions from the section's timetable.
   *
   * `sessions` is UNIQUE (section_id, session_date, starts_at), so re-running
   * this after adding a slot fills the gaps instead of duplicating what is
   * already there — and an attendance record already taken against an existing
   * session is never disturbed.
   */
  async generateSessions(
    sectionId: string,
    dto: GenerateSessionsDto,
    actor: Actor,
  ): Promise<{ created: number; skipped: number }> {
    const [section, term, settings, slots] = await Promise.all([
      this.prisma.sections.findUniqueOrThrow({
        where: { id: sectionId },
        select: { academic_year_id: true },
      }),
      this.prisma.terms.findUniqueOrThrow({ where: { id: dto.termId } }),
      this.prisma.institute_settings.findUniqueOrThrow({ where: { id: 1 } }),
      this.prisma.timetable_slots.findMany({
        where: { section_id: sectionId },
      }),
    ]);

    if (term.academic_year_id !== section.academic_year_id) {
      throw new ConflictException(
        'That term belongs to a different academic year than this section',
      );
    }
    if (slots.length === 0) {
      throw new ConflictException(
        'This section has no timetable slots to generate sessions from',
      );
    }

    const planned = planSessions({
      termStart: term.starts_on,
      termEnd: term.ends_on,
      sessionsPerTerm: settings.sessions_per_term,
      offDays: dto.offDays,
      slots: slots.map((slot) => ({
        id: slot.id,
        subjectId: slot.subject_id,
        teacherId: slot.teacher_id,
        weekday: slot.weekday,
        slotOrder: slot.slot_order,
        startsAt: fromTimeValue(slot.starts_at),
        endsAt: fromTimeValue(slot.ends_at),
        room: slot.room,
        mode: slot.mode,
        effectiveFrom: slot.effective_from,
        effectiveTo: slot.effective_to,
      })),
    });

    const result = await this.prisma.sessions.createMany({
      data: planned.map((session) => ({
        section_id: sectionId,
        subject_id: session.subjectId,
        teacher_id: session.teacherId,
        slot_id: session.slotId,
        session_no: session.sessionNo,
        session_date: session.sessionDate,
        starts_at: toTimeValue(session.startsAt),
        ends_at: toTimeValue(session.endsAt),
        mode: session.mode,
        room: session.room,
        created_by: actor.userId,
      })),
      // The unique constraint is the idempotency mechanism; skipping duplicates
      // is what makes re-running safe rather than destructive.
      skipDuplicates: true,
    });

    await this.audit.record(actor, {
      action: 'session.generate',
      entityType: 'section',
      entityId: sectionId,
      after: {
        termId: dto.termId,
        planned: planned.length,
        created: result.count,
      },
    });
    return {
      created: result.count,
      skipped: planned.length - result.count,
    };
  }

  /**
   * §8 Phase 3, "teacher clash detection". Loads only the candidate teacher's
   * other slots rather than the whole timetable: a teacher can teach in several
   * sections, so a clash is not confined to the section being edited.
   */
  private async assertNoTeacherClash(
    sectionId: string,
    slotId: string | null,
    candidate: {
      teacherId: string | null;
      weekday: number;
      startsAt: string;
      endsAt: string;
      effectiveFrom: Date | null;
      effectiveTo: Date | null;
    },
  ): Promise<void> {
    if (candidate.teacherId === null) {
      return;
    }
    const others = await this.prisma.timetable_slots.findMany({
      where: { teacher_id: candidate.teacherId, weekday: candidate.weekday },
      include: { sections: { select: { name: true } } },
    });

    const clashes = findClashes(
      { slotId: slotId ?? 'new', ...candidate },
      others.map((slot) => ({
        slotId: slot.id,
        teacherId: slot.teacher_id,
        weekday: slot.weekday,
        startsAt: fromTimeValue(slot.starts_at),
        endsAt: fromTimeValue(slot.ends_at),
        effectiveFrom: slot.effective_from,
        effectiveTo: slot.effective_to,
      })),
    );

    if (clashes.length > 0) {
      const names = clashes
        .map((clash) => others.find((slot) => slot.id === clash.slotId))
        .map(
          (slot) =>
            `${slot?.sections.name ?? 'another section'} at ${fromTimeValue(slot!.starts_at)}`,
        )
        .join(', ');
      throw new ConflictException(
        `This teacher is already scheduled that day: ${names}. Section ${sectionId} was not changed.`,
      );
    }
  }

  private async assertSectionAccess(
    sectionId: string,
    viewer: AuthenticatedUser,
  ): Promise<void> {
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
  }
}

/**
 * Postgres `TIME` has no date. Prisma models it as a Date, so a wall-clock
 * time is carried on the Unix epoch in UTC — anchoring it to any other day
 * would make the value drift with the timezone.
 */
function toTimeValue(time: string): Date {
  return new Date(`1970-01-01T${time}:00Z`);
}

function fromTimeValue(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function toSlotView(row: SlotRecord): TimetableSlotView {
  return {
    id: row.id,
    sectionId: row.section_id,
    subjectId: row.subject_id,
    subjectNameAr: row.subjects.name_ar,
    teacherId: row.teacher_id,
    teacherName: row.users_timetable_slots_teacher_idTousers?.full_name ?? null,
    weekday: row.weekday,
    slotOrder: row.slot_order,
    startsAt: fromTimeValue(row.starts_at),
    endsAt: fromTimeValue(row.ends_at),
    room: row.room,
    mode: row.mode,
    effectiveFrom: row.effective_from && toDateOnlyString(row.effective_from),
    effectiveTo: row.effective_to && toDateOnlyString(row.effective_to),
  };
}
