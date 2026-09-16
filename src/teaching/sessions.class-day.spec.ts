import { ConflictException } from '@nestjs/common';
import type { AuditService } from '../common/audit.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SessionsService } from './sessions.service';
import type { CreateClassDayDto } from './dto/teaching.schema';

/* A class day fans each period out to the cohorts its gender scope names. This
   is the load-bearing rule of the per-date scheduling: a `both` period must
   land in the boys' AND the girls' class as two separate sessions (so each
   keeps its own attendance), while a `male`/`female` period lands in one.

   Mocked at the boundary only: Prisma is the database. With it stubbed, the
   rows the service asks createMany to write ARE the observable behaviour. */

const VIEWER: AuthenticatedUser = { id: 'h1', role: 'head_teacher', branchId: null };
const ACTOR = { userId: 'h1' };

const SECTIONS = [
  { id: 'sec-boys', gender: 'male' as const },
  { id: 'sec-girls', gender: 'female' as const },
];

function buildService(sections: typeof SECTIONS) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    sections: { findMany: jest.fn().mockResolvedValue(sections) },
    sessions: { createMany },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SessionsService(
    prisma as unknown as ConstructorParameters<typeof SessionsService>[0],
    audit as unknown as AuditService,
  );
  return { service, prisma, createMany };
}

function classDay(periods: CreateClassDayDto['periods']): CreateClassDayDto {
  return {
    academicYearId: 1,
    sessionDate: new Date('2026-09-18T00:00:00Z'),
    periods,
  } as CreateClassDayDto;
}

describe('SessionsService.createClassDay — gender fan-out', () => {
  it('writes a `both` period once per cohort and a scoped period once', async () => {
    const built = buildService(SECTIONS);

    await built.service.createClassDay(
      2,
      classDay([
        { subjectId: 10, slotOrder: 1, startsAt: '16:00', endsAt: '17:00', sheikhName: 'الشيخ أحمد', genderScope: 'both' },
        { subjectId: 11, slotOrder: 2, startsAt: '17:00', endsAt: '18:00', sheikhName: null, genderScope: 'female' },
      ]),
      ACTOR,
      VIEWER,
    );

    const rows = built.createMany.mock.calls[0][0].data as Array<{
      section_id: string;
      subject_id: number;
      session_no: number;
      sheikh_name: string | null;
    }>;
    // both → boys + girls; female → girls only. Three sessions in total.
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.subject_id === 10).map((r) => r.section_id).sort()).toEqual(
      ['sec-boys', 'sec-girls'],
    );
    expect(rows.filter((r) => r.subject_id === 11)).toEqual([
      expect.objectContaining({ section_id: 'sec-girls', session_no: 2, sheikh_name: null }),
    ]);
    // The sheikh's name rides on the session, not a users FK.
    expect(rows.find((r) => r.subject_id === 10)?.sheikh_name).toBe('الشيخ أحمد');
  });

  it('refuses to schedule a level that has no classes provisioned', async () => {
    const built = buildService([]);

    await expect(
      built.service.createClassDay(
        2,
        classDay([
          { subjectId: 10, slotOrder: 1, startsAt: '16:00', endsAt: '17:00', sheikhName: null, genderScope: 'both' },
        ]),
        ACTOR,
        VIEWER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(built.createMany).not.toHaveBeenCalled();
  });
});
