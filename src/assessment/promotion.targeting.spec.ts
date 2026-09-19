import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuditService } from '../common/audit.service';
import { PromotionService } from './promotion.service';
import type { ConfirmPromotionDto } from './dto/assessment.schema';

/**
 * §4.3 — where a confirmed promotion actually *puts* each student.
 *
 * `confirm` writes two things: the verdict on this year's enrolment, and a new
 * enrolment in next year's section. The verdict half is covered by
 * `promotion.override.spec.ts` and `promotion.confirm.spec.ts`; nothing covered
 * the placement half, which is `loadTargetSections`.
 *
 * Two defects were found here and are now fixed: a `repeat` was advanced a
 * level like everything else, and nothing stopped a run promoting students
 * backwards into an earlier year. The cases that recorded them are ordinary
 * assertions now.
 */

const HEAD: AuthenticatedUser = {
  id: 'h1',
  role: 'head_teacher',
  branchId: null,
};
const ACTOR: Actor = { userId: 'h1', ipAddress: '127.0.0.1' };

const RULE = {
  level_id: null,
  max_carried_subjects: 3,
  // Off, so a carry-sized failure decides promote_with_carry rather than
  // being parked in a makeup round that writes no placement at all.
  makeup_round_enabled: false,
  carry_forward_enabled: true,
  mandatory_can_be_carried: true,
};

/** L1 → L2 → L3 → COMP, which only a clean-entry student may enter (R20). */
const LEVELS = [
  {
    id: 1,
    code: 'L1',
    sort_order: 1,
    allows_carry: true,
    is_terminal: false,
    requires_clean_entry: false,
  },
  {
    id: 2,
    code: 'L2',
    sort_order: 2,
    allows_carry: true,
    is_terminal: false,
    requires_clean_entry: false,
  },
  {
    id: 3,
    code: 'L3',
    sort_order: 3,
    allows_carry: true,
    is_terminal: true,
    requires_clean_entry: false,
  },
  {
    id: 4,
    code: 'COMP',
    sort_order: 4,
    allows_carry: true,
    is_terminal: true,
    requires_clean_entry: true,
  },
];

/** Next year's sections: one per level, for this gender and branch. */
const TARGET_SECTIONS = LEVELS.map((level) => ({
  id: `sec-y2-L${level.id}`,
  level_id: level.id,
  gender: 'male',
  branch_id: 1,
  academic_year_id: 2,
}));

/** A failed exam result for one subject, in the shape `preview` reads. */
function failedUnit(subjectId: number, nameAr: string) {
  return {
    result: 'fail',
    exams: {
      curriculum: {
        id: subjectId,
        subject_id: subjectId,
        is_mandatory: false,
        subjects: { name_ar: nameAr },
      },
    },
  };
}

type FailedUnitRow = ReturnType<typeof failedUnit>;

function enrollment(levelId: number, failed: FailedUnitRow[]) {
  const level = LEVELS.find((candidate) => candidate.id === levelId);
  return {
    id: 'enr1',
    student_id: 'stu1',
    gender: 'male',
    branch_id: 1,
    student: { full_name: 'أحمد سالم' },
    is_historical: false,
    final_decision: null,
    decided_at: null,
    section: { level_id: levelId, levels: level },
    exam_results: failed,
    promotion_overrides: [],
    carried_subjects_carried_subjects_enrollment_idToenrollments: [],
  };
}

function buildService(levelId: number, failed: FailedUnitRow[] = []) {
  const tx = {
    enrollments: {
      update: jest.fn().mockResolvedValue({}),
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'enr2', created_at: new Date() }),
    },
    students: { update: jest.fn().mockResolvedValue({}) },
    carried_subjects: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    enrollments: {
      findMany: jest
        .fn()
        // preview's read, then loadTargetSections' read of the same enrolment
        .mockResolvedValueOnce([enrollment(levelId, failed)])
        .mockResolvedValue([
          {
            id: 'enr1',
            gender: 'male',
            branch_id: 1,
            section: { level_id: levelId },
          },
        ]),
    },
    progression_rules: { findMany: jest.fn().mockResolvedValue([RULE]) },
    /* Chronology lives in `hijri_year`, not in `id`: year id 1 is 1447 and id 2
       is 1448, so the default DTO promotes forwards. The backwards case asks
       for ids 5 → 2, which resolve to 1451 → 1448. */
    academic_years: {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, hijri_year: 1447 },
        { id: 2, hijri_year: 1448 },
        { id: 5, hijri_year: 1451 },
      ]),
    },
    levels: { findMany: jest.fn().mockResolvedValue(LEVELS) },
    sections: { findMany: jest.fn().mockResolvedValue(TARGET_SECTIONS) },
    $transaction: jest
      .fn()
      .mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PromotionService(
    prisma as unknown as ConstructorParameters<typeof PromotionService>[0],
    audit as unknown as AuditService,
  );
  return { service, tx };
}

const dto = (overrides: Partial<ConfirmPromotionDto> = {}) =>
  ({
    academicYearId: 1,
    afterMakeup: false,
    enrollmentIds: ['enr1'],
    targetAcademicYearId: 2,
    ...overrides,
  }) as unknown as ConfirmPromotionDto;

/** The two write shapes these assertions read back off the mocks. */
interface EnrollmentUpsertArg {
  create: { section_id: string; entry_type: string };
}
interface CarryUpsertArg {
  create: {
    enrollment_id: string;
    from_enrollment_id: string;
    origin_level_id: number;
  };
}

function upsertArgs<T>(mock: jest.Mock): T[] {
  return (mock.mock.calls as unknown[][]).map((call) => call[0] as T);
}

/** The section the new enrolment was created in, or null if none was. */
function placedSection(tx: {
  enrollments: { upsert: jest.Mock };
}): string | null {
  const [first] = upsertArgs<EnrollmentUpsertArg>(tx.enrollments.upsert);
  return first ? first.create.section_id : null;
}

describe('PromotionService.confirm — where each decision places the student', () => {
  it('moves a clean pass into the next level', async () => {
    const { service, tx } = buildService(1);

    await service.confirm(dto(), ACTOR, HEAD);

    expect(placedSection(tx)).toBe('sec-y2-L2');
  });

  it('graduates a clean terminal level and creates no forward enrolment', async () => {
    const { service, tx } = buildService(3);

    const result = await service.confirm(dto(), ACTOR, HEAD);

    expect(result.graduated).toBe(1);
    expect(tx.students.update).toHaveBeenCalledWith({
      where: { id: 'stu1' },
      data: { status: 'graduated' },
    });
    expect(tx.enrollments.upsert).not.toHaveBeenCalled();
  });

  // R20: COMP is elective and student-chosen, so a student finishing the level
  // before it is never swept into it by a promotion run.
  it('does not place anyone into a level that requires clean entry', async () => {
    const { service, tx } = buildService(2, [failedUnit(1, 'الفقه')]);

    await service.confirm(dto(), ACTOR, HEAD);

    expect(placedSection(tx)).not.toBe('sec-y2-L4');
  });

  it('writes one carried subject per failure, against the new enrolment', async () => {
    const { service, tx } = buildService(1, [
      failedUnit(1, 'الفقه'),
      failedUnit(2, 'النحو'),
    ]);

    const result = await service.confirm(dto(), ACTOR, HEAD);

    expect(result.carriesWritten).toBe(2);
    expect(tx.carried_subjects.upsert).toHaveBeenCalledTimes(2);
    const [first] = upsertArgs<CarryUpsertArg>(tx.carried_subjects.upsert);
    expect(first.create.enrollment_id).toBe('enr2');
    expect(first.create.from_enrollment_id).toBe('enr1');
    // The debt is tagged with the level it was incurred at, not the new one.
    expect(first.create.origin_level_id).toBe(1);
  });

  it('moves nobody forward when no target year is named', async () => {
    const { service, tx } = buildService(1);

    const result = await service.confirm(
      dto({ targetAcademicYearId: undefined }),
      ACTOR,
      HEAD,
    );

    expect(tx.enrollments.upsert).not.toHaveBeenCalled();
    expect(result.notMovedForward).toBe(1);
  });

  /* `loadTargetSections` used to receive only the DTO and never read the
     decision, so it advanced `sort_order + 1` for every row alike: a student
     decided `repeat` was enrolled into the NEXT level's section carrying
     entry_type 'repeater' — the roster said they moved up, the verdict said
     they did not. Four failures exceed max_carried_subjects of 3, which is what
     makes the decision `repeat` here. */
  it('leaves a repeating student in the same level', async () => {
    const { service, tx } = buildService(1, [
      failedUnit(1, 'الفقه'),
      failedUnit(2, 'النحو'),
      failedUnit(3, 'العقيدة'),
      failedUnit(4, 'التفسير'),
    ]);

    await service.confirm(dto(), ACTOR, HEAD);

    expect(placedSection(tx)).toBe('sec-y2-L1');
  });

  /* `academic_years.id` is an autoincrement that carries no chronology —
     `hijri_year` does — so nothing about the ids being 5 and 2 says which way
     round they are. Unchecked, a closed earlier year is a valid target and a
     whole level can be promoted backwards into it. */
  it('refuses a target year that precedes the source year', async () => {
    const { service } = buildService(1);

    await expect(
      service.confirm(
        dto({ academicYearId: 5, targetAcademicYearId: 2 }),
        ACTOR,
        HEAD,
      ),
    ).rejects.toThrow(/does not come after/);
  });

  it('refuses a target year equal to the year being closed', async () => {
    const { service } = buildService(1);

    await expect(
      service.confirm(
        dto({ academicYearId: 2, targetAcademicYearId: 2 }),
        ACTOR,
        HEAD,
      ),
    ).rejects.toThrow(/moves students into a later year/);
  });

  /* A repeater is not starting the level again from nothing — they retake the
     subjects they failed. Recording exactly those is what turns "repeats
     المستوى الأول" into "owes الفقه and النحو from المستوى الأول", which the
     roster, the COMP gate and the export all already read. */
  describe('a repeater retakes only the subjects they failed', () => {
    const FOUR_FAILURES = [
      failedUnit(1, 'الفقه'),
      failedUnit(2, 'النحو'),
      failedUnit(3, 'العقيدة'),
      failedUnit(4, 'التفسير'),
    ];

    it('records each failed subject against the new enrolment', async () => {
      const { service, tx } = buildService(1, FOUR_FAILURES);

      const result = await service.confirm(dto(), ACTOR, HEAD);

      expect(result.carriesWritten).toBe(4);
      const written = upsertArgs<CarryUpsertArg>(tx.carried_subjects.upsert);
      expect(written).toHaveLength(4);
      expect(
        written.every((call) => call.create.enrollment_id === 'enr2'),
      ).toBe(true);
    });

    it('attributes the debt to the level it was failed at', async () => {
      const { service, tx } = buildService(2, FOUR_FAILURES);

      await service.confirm(dto(), ACTOR, HEAD);

      const [first] = upsertArgs<CarryUpsertArg>(tx.carried_subjects.upsert);
      expect(first.create.origin_level_id).toBe(2);
      expect(first.create.from_enrollment_id).toBe('enr1');
    });

    it('marks the new enrolment as a repeat of the same level', async () => {
      const { service, tx } = buildService(1, FOUR_FAILURES);

      await service.confirm(dto(), ACTOR, HEAD);

      const [created] = upsertArgs<EnrollmentUpsertArg>(tx.enrollments.upsert);
      expect(created.create.entry_type).toBe('repeater');
      expect(created.create.section_id).toBe('sec-y2-L1');
    });

    /* The retake list is the failures, so a clean pass must leave it empty. */
    it('writes nothing for a student who failed nothing', async () => {
      const { service, tx } = buildService(1);

      await service.confirm(dto(), ACTOR, HEAD);

      expect(tx.carried_subjects.upsert).not.toHaveBeenCalled();
    });
  });
});
