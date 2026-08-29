import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { canAccessSection, sectionScope } from '../common/access-scope';
import { AuditService } from '../common/audit.service';
import { toDateOnlyString } from '../common/date-only.schema';
import { buildPage, Page, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type {
  ListSessionsQueryDto,
  UpdateSessionDto,
} from './dto/teaching.schema';

export interface SessionView {
  id: string;
  sectionId: string;
  sectionName: string;
  subjectId: number;
  subjectNameAr: string;
  teacherId: string | null;
  sessionNo: number | null;
  sessionDate: string;
  startsAt: string;
  endsAt: string;
  mode: string;
  room: string | null;
  meetingUrl: string | null;
  isException: boolean;
  status: string;
  cancelReason: string | null;
}

const SESSION_SHAPE = {
  include: {
    subjects: { select: { name_ar: true } },
    sections: { select: { name: true } },
  },
} satisfies Prisma.sessionsDefaultArgs;

type SessionRecord = Prisma.sessionsGetPayload<typeof SESSION_SHAPE>;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListSessionsQueryDto,
    viewer: AuthenticatedUser,
  ): Promise<Page<SessionView>> {
    const where: Prisma.sessionsWhereInput = {
      // A teacher's session list is their own sections only — the same scope
      // fragment every other read uses (spec §9).
      sections: sectionScope(viewer),
      ...(query.sectionId ? { section_id: query.sectionId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            session_date: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.sessions.findMany({
        where,
        ...SESSION_SHAPE,
        orderBy: [{ session_date: 'asc' }, { starts_at: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.sessions.count({ where }),
    ]);
    return buildPage(rows.map(toSessionView), total, query);
  }

  /**
   * R4: "Sessions may be onsite, online, or hybrid" and Friday is only the
   * default day, so any single session can be moved or switched without
   * touching the timetable it came from. `is_exception` marks the ones that
   * no longer match their slot, which is what a regenerate must not overwrite.
   */
  async update(
    id: string,
    dto: UpdateSessionDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<SessionView> {
    const before = await this.prisma.sessions.findUniqueOrThrow({
      where: { id },
      ...SESSION_SHAPE,
    });
    await this.assertSectionAccess(before.section_id, viewer);

    // Checked against the MERGED row, not the patch: an omitted field in a
    // PATCH means "leave it alone", so a session that already has a meeting
    // URL may legally be switched to online without resending it. Doing this
    // in the schema would either reject that, or (as it did) let the DDL's
    // CHECK fire and surface as a 500.
    const mode = dto.mode ?? before.mode;
    const meetingUrl =
      dto.meetingUrl === undefined ? before.meeting_url : dto.meetingUrl;
    const status = dto.status ?? before.status;
    const cancelReason =
      dto.cancelReason === undefined ? before.cancel_reason : dto.cancelReason;

    if (mode === 'online' && meetingUrl === null && status !== 'cancelled') {
      throw new BadRequestException('An online session needs a meeting URL');
    }
    if (status === 'cancelled' && !cancelReason) {
      throw new BadRequestException('Cancelling a session needs a reason');
    }

    const movedOrRemoded =
      dto.sessionDate !== undefined ||
      dto.startsAt !== undefined ||
      dto.mode !== undefined;

    const updated = await this.prisma.sessions.update({
      where: { id },
      data: {
        session_date: dto.sessionDate,
        starts_at: dto.startsAt ? toTimeValue(dto.startsAt) : undefined,
        ends_at: dto.endsAt ? toTimeValue(dto.endsAt) : undefined,
        mode: dto.mode,
        room: dto.room,
        meeting_url: dto.meetingUrl,
        teacher_id: dto.teacherId,
        status: dto.status,
        cancel_reason: dto.cancelReason,
        ...(movedOrRemoded ? { is_exception: true } : {}),
      },
      ...SESSION_SHAPE,
    });

    await this.audit.record(actor, {
      action: 'session.update',
      entityType: 'session',
      entityId: id,
      before: toSessionView(before),
      after: toSessionView(updated),
    });
    return toSessionView(updated);
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

// Postgres TIME carries no date; the value rides on the Unix epoch in UTC.
function toTimeValue(time: string): Date {
  return new Date(`1970-01-01T${time}:00Z`);
}

function fromTimeValue(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function toSessionView(row: SessionRecord): SessionView {
  return {
    id: row.id,
    sectionId: row.section_id,
    sectionName: row.sections.name,
    subjectId: row.subject_id,
    subjectNameAr: row.subjects.name_ar,
    teacherId: row.teacher_id,
    sessionNo: row.session_no,
    sessionDate: toDateOnlyString(row.session_date),
    startsAt: fromTimeValue(row.starts_at),
    endsAt: fromTimeValue(row.ends_at),
    mode: row.mode,
    room: row.room,
    meetingUrl: row.meeting_url,
    isException: row.is_exception,
    status: row.status,
    cancelReason: row.cancel_reason,
  };
}
