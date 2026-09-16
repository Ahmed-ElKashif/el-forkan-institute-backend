import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import type { AuditService } from '../common/audit.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ResultsService } from './results.service';
import type { CorrectScoreDto, SaveScoresDto } from './dto/assessment.schema';

/* R20's COMP gate refuses entry while any carry is `pending`. Nothing used to
   write `cleared`, so passing a carried subject settled nothing and the student
   was locked out of the terminal level permanently. These tests pin the fix in
   both directions, because an R8 correction can move the verdict either way.

   Mocked at the boundaries only: Prisma is the database and AuditService writes
   to it. What matters here is which rows the service asks the database to
   change — with the database stubbed, that request IS the observable behaviour. */

const VIEWER: AuthenticatedUser = {
  id: 'v',
  role: 'head_teacher',
  branchId: null,
};
const ACTOR: Actor = { userId: 'v' };

const SUBJECT_ID = 42;
const CURRICULUM = {
  subject_id: SUBJECT_ID,
  max_score: new Prisma.Decimal(100),
  pass_score: new Prisma.Decimal(50),
  grading_mode: 'score',
  weight: new Prisma.Decimal(1),
};

function buildService() {
  // The interactive transaction hands this same object to the callback, so the
  // assertions read the writes the service actually issued inside it.
  const tx = {
    exam_results: { upsert: jest.fn(), update: jest.fn() },
    grade_changes: { create: jest.fn() },
    enrollments: { findMany: jest.fn() },
    carried_subjects: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    exams: { findUnique: jest.fn() },
    exam_eligibility: { findMany: jest.fn() },
    exam_results: { findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ResultsService(
    prisma as unknown as ConstructorParameters<typeof ResultsService>[0],
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, audit };
}

/** Marks one paper for one enrolment. `score` decides pass (>=50) or fail. */
function saveOneMark(
  built: ReturnType<typeof buildService>,
  score: number | null,
): Promise<{ saved: number }> {
  built.prisma.exams.findUnique.mockResolvedValue({
    id: 'exam1',
    branch_id: 1,
    is_locked: false,
    curriculum: CURRICULUM,
  });
  built.prisma.exam_eligibility.findMany.mockResolvedValue([
    { enrollment_id: 'enr-l3' },
  ]);
  const dto = {
    entries: [{ enrollmentId: 'enr-l3', score, isAbsent: false }],
  } as SaveScoresDto;
  return built.service.saveScores('exam1', dto, ACTOR, VIEWER);
}

/** Corrects an existing result, moving it to `score`. */
function correctOneMark(
  built: ReturnType<typeof buildService>,
  score: number | null,
): Promise<unknown> {
  built.prisma.exam_results.findUniqueOrThrow.mockResolvedValue({
    id: 'res1',
    enrollment_id: 'enr-l3',
    score: new Prisma.Decimal(20),
    result: 'fail',
    exams: { branch_id: 1, curriculum: CURRICULUM },
    enrollments: { student: { full_name: 'أحمد', student_code: 'S-1' } },
  });
  built.tx.exam_results.update.mockResolvedValue({
    id: 'res1',
    // A real Decimal, because correctScore maps it back through .toNumber().
    score: score === null ? null : new Prisma.Decimal(score),
    is_absent: false,
  });
  const dto = {
    score,
    isAbsent: false,
    reason: 'مراجعة الورقة',
  } as CorrectScoreDto;
  return built.service.correctScore('res1', dto, ACTOR, VIEWER);
}

/** The student behind the marked enrolment also holds an older L1 enrolment —
 *  which is where a two-year-old carry lives. */
function studentHoldsTwoEnrollments(
  built: ReturnType<typeof buildService>,
): void {
  built.tx.enrollments.findMany
    .mockResolvedValueOnce([{ student_id: 'stu1' }])
    .mockResolvedValueOnce([{ id: 'enr-l1' }, { id: 'enr-l3' }]);
}

describe('ResultsService — settling carried subjects (R20)', () => {
  it('clears the carry when a passing mark is saved, reaching an earlier year’s enrolment', async () => {
    const built = buildService();
    studentHoldsTwoEnrollments(built);

    await saveOneMark(built, 80);

    // The carry sits on the L1 enrolment, not the one being marked — matching on
    // the student is the whole point of the fix (§4.6).
    expect(built.tx.carried_subjects.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'pending',
        subject_id: SUBJECT_ID,
        enrollment_id: { in: ['enr-l1', 'enr-l3'] },
      },
      data: { status: 'cleared', cleared_at: expect.any(Date) },
    });
  });

  it('settles nothing when the paper produced no passes', async () => {
    const built = buildService();

    await saveOneMark(built, 20);

    expect(built.tx.carried_subjects.updateMany).not.toHaveBeenCalled();
  });

  it('records how many carries a save settled, so the audit shows the consequence', async () => {
    const built = buildService();
    studentHoldsTwoEnrollments(built);

    await saveOneMark(built, 80);

    expect(built.audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: 'exam.scores.save',
        after: { entries: 1, carriesCleared: 1 },
      }),
    );
  });

  it('clears the carry when an R8 correction turns a fail into a pass', async () => {
    const built = buildService();
    studentHoldsTwoEnrollments(built);

    await correctOneMark(built, 75);

    expect(built.tx.carried_subjects.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'pending' }),
        data: { status: 'cleared', cleared_at: expect.any(Date) },
      }),
    );
  });

  it('reopens the carry when an R8 correction takes a pass back to a fail', async () => {
    const built = buildService();
    studentHoldsTwoEnrollments(built);

    await correctOneMark(built, 30);

    // Otherwise the debt stays settled on a mark that no longer exists and the
    // student walks through the COMP gate on a subject they have not passed.
    expect(built.tx.carried_subjects.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'cleared' }),
        data: { status: 'pending', cleared_at: null },
      }),
    );
  });
});
