import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuditService } from '../common/audit.service';
import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PromotionService } from './promotion.service';
import type {
  OverridePromotionDto,
  RunPromotionDto,
} from './dto/assessment.schema';

/* §4.3 lets a human disagree with the engine, on the record. These pin the three
   things that makes safe: the override wins without erasing what it overrode,
   it belongs to one round only, and a teacher can only reach their own classes.

   Mocked at the boundaries only: Prisma is the database, AuditService writes
   to it. */

const HEAD: AuthenticatedUser = {
  id: 'h1',
  role: 'head_teacher',
  branchId: null,
};
const BRANCH_HEAD: AuthenticatedUser = {
  id: 'h2',
  role: 'head_teacher',
  branchId: 1,
};
const TEACHER: AuthenticatedUser = { id: 't1', role: 'teacher', branchId: 1 };
const ACTOR: Actor = { userId: 'h1', ip: null, userAgent: null };

/** One clean enrolment: nothing failed, so the engine says `promote`. */
function enrollment(overrides: unknown[] = []) {
  return {
    id: 'enr1',
    student_id: 'stu1',
    student: { full_name: 'أحمد سالم' },
    is_historical: false,
    section: {
      levels: {
        id: 2,
        code: 'L1',
        allows_carry: true,
        is_terminal: false,
      },
    },
    exam_results: [],
    promotion_overrides: overrides,
  };
}

const RULE = {
  level_id: null,
  max_carried_subjects: 3,
  makeup_round_enabled: true,
  carry_forward_enabled: true,
  mandatory_can_be_carried: false,
};

function buildService() {
  const prisma = {
    enrollments: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    progression_rules: { findMany: jest.fn().mockResolvedValue([RULE]) },
    promotion_overrides: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PromotionService(
    prisma as unknown as ConstructorParameters<typeof PromotionService>[0],
    audit as unknown as AuditService,
  );
  return { service, prisma, audit };
}

function run(extra: Partial<RunPromotionDto> = {}): RunPromotionDto {
  return { academicYearId: 1, afterMakeup: false, ...extra };
}

describe('PromotionService.preview — overrides', () => {
  it('applies the override while still reporting what the engine decided', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findMany.mockResolvedValue([
      enrollment([
        {
          decision: 'repeat',
          reason: 'غياب متكرر لم يُسجَّل',
          overridden_by: 'h1',
          overridden_at: new Date('2026-06-01T00:00:00Z'),
        },
      ]),
    ]);

    const [row] = await service.preview(run(), HEAD);

    // The screen has to be able to show what is being disagreed with.
    expect(row.decision).toBe('repeat');
    expect(row.computedDecision).toBe('promote');
    expect(row.override).toEqual({
      decision: 'repeat',
      reason: 'غياب متكرر لم يُسجَّل',
      overriddenBy: 'h1',
      overriddenAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('leaves the engine’s verdict alone when nothing was overridden', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findMany.mockResolvedValue([enrollment()]);

    const [row] = await service.preview(run(), HEAD);

    expect(row.decision).toBe('promote');
    expect(row.override).toBeNull();
  });

  it('reads only the round being run, so a pre-makeup override cannot decide the makeup', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findMany.mockResolvedValue([enrollment()]);

    await service.preview(run({ afterMakeup: true }), HEAD);

    const [args] = prisma.enrollments.findMany.mock.calls[0] as [
      {
        include: { promotion_overrides: { where: { after_makeup: boolean } } };
      },
    ];
    expect(args.include.promotion_overrides.where).toEqual({
      after_makeup: true,
    });
  });

  it('never lets an override decide a blocked row', async () => {
    const { service, prisma } = buildService();
    // A historical enrolment is never re-decided (§4.3), so an override on it
    // would offer a verdict `confirm` refuses to honour.
    prisma.enrollments.findMany.mockResolvedValue([
      {
        ...enrollment([
          {
            decision: 'promote',
            reason: 'x',
            overridden_by: 'h1',
            overridden_at: new Date(),
          },
        ]),
        is_historical: true,
      },
    ]);

    const [row] = await service.preview(run(), HEAD);

    expect(row.override).toBeNull();
    expect(row.blocker).toContain('Historical');
  });
});

describe('PromotionService.preview — scoping', () => {
  it('keeps a teacher’s scope when they also filter by level', async () => {
    /* Regression: the scope and the level filter both narrow `section`. Spread
       as two keys the level filter wins, and a teacher would have previewed
       every enrolment at that level in the branch. */
    const { service, prisma } = buildService();

    await service.preview(run({ levelId: 7 }), TEACHER);

    const [args] = prisma.enrollments.findMany.mock.calls[0] as [
      { where: { section: Record<string, unknown> } },
    ];
    expect(args.where.section).toEqual({
      branch_id: 1,
      section_teachers: { some: { user_id: 't1' } },
      level_id: 7,
    });
  });

  it('scopes a branch-bound head teacher to their branch but not to their own classes', async () => {
    const { service, prisma } = buildService();

    await service.preview(run(), BRANCH_HEAD);

    const [args] = prisma.enrollments.findMany.mock.calls[0] as [
      { where: { section: Record<string, unknown> } },
    ];
    expect(args.where.section).toEqual({ branch_id: 1 });
  });

  it('reads every branch for an institute-wide head teacher', async () => {
    const { service, prisma } = buildService();

    await service.preview(run(), HEAD);

    const [args] = prisma.enrollments.findMany.mock.calls[0] as [
      { where: { section: Record<string, unknown> } },
    ];
    expect(args.where.section).toEqual({});
  });
});

describe('PromotionService.setDecisionOverride', () => {
  const dto = {
    decision: 'repeat',
    afterMakeup: false,
    reason: 'غياب متكرر',
  } as OverridePromotionDto;

  function reachable(sectionTeachers: { user_id: string }[]) {
    return {
      id: 'enr1',
      academic_year_id: 1,
      section: { branch_id: 1, section_teachers: sectionTeachers },
    };
  }

  it('records the override and audits it with the reason', async () => {
    const { service, prisma, audit } = buildService();
    prisma.enrollments.findUnique.mockResolvedValue(
      reachable([{ user_id: 't1' }]),
    );

    await service.setDecisionOverride('enr1', dto, ACTOR, TEACHER);

    expect(prisma.promotion_overrides.upsert).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: 'promotion.decision.override',
        entityId: 'enr1',
        after: { decision: 'repeat', afterMakeup: false, reason: 'غياب متكرر' },
      }),
    );
  });

  it('refuses a teacher an enrolment in their branch but not in their classes', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findUnique.mockResolvedValue(
      reachable([{ user_id: 'someone-else' }]),
    );

    await expect(
      service.setDecisionOverride('enr1', dto, ACTOR, TEACHER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.promotion_overrides.upsert).not.toHaveBeenCalled();
  });

  it('answers not-found for another branch, so it cannot be used to probe', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findUnique.mockResolvedValue({
      ...reachable([{ user_id: 't1' }]),
      section: { branch_id: 2, section_teachers: [{ user_id: 't1' }] },
    });

    await expect(
      service.setDecisionOverride('enr1', dto, ACTOR, TEACHER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PromotionService.clearDecisionOverride', () => {
  it('withdraws the override so the engine’s verdict stands again', async () => {
    const { service, prisma, audit } = buildService();
    prisma.enrollments.findUnique.mockResolvedValue({
      id: 'enr1',
      academic_year_id: 1,
      section: { branch_id: 1, section_teachers: [{ user_id: 't1' }] },
    });

    const out = await service.clearDecisionOverride(
      'enr1',
      false,
      ACTOR,
      TEACHER,
    );

    expect(out).toEqual({ cleared: true });
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ action: 'promotion.decision.override.clear' }),
    );
  });

  it('does not audit a clear that removed nothing', async () => {
    const { service, prisma, audit } = buildService();
    prisma.enrollments.findUnique.mockResolvedValue({
      id: 'enr1',
      academic_year_id: 1,
      section: { branch_id: 1, section_teachers: [{ user_id: 't1' }] },
    });
    prisma.promotion_overrides.deleteMany.mockResolvedValue({ count: 0 });

    const out = await service.clearDecisionOverride(
      'enr1',
      false,
      ACTOR,
      TEACHER,
    );

    expect(out).toEqual({ cleared: false });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
