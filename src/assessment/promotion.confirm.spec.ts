import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuditService } from '../common/audit.service';
import { PromotionService } from './promotion.service';
import type { ConfirmPromotionDto } from './dto/assessment.schema';

const HEAD: AuthenticatedUser = { id: 'h1', role: 'head_teacher', branchId: null };
const ACTOR: Actor = { userId: 'h1', ipAddress: '127.0.0.1' };

const RULE = {
  level_id: null,
  max_carried_subjects: 3,
  makeup_round_enabled: true,
  carry_forward_enabled: true,
  mandatory_can_be_carried: false,
};

/** One enrolment the preview will decide, shaped to the `preview` include. */
function enrollment(isTerminal: boolean) {
  return {
    id: 'enr1',
    student_id: 'stu1',
    student: { full_name: 'أحمد سالم' },
    is_historical: false,
    final_decision: null,
    decided_at: null,
    section: { levels: { id: 5, code: 'L4', allows_carry: true, is_terminal: isTerminal } },
    exam_results: [], // nothing failed → a clean terminal level graduates
    promotion_overrides: [],
    carried_subjects_carried_subjects_enrollment_idToenrollments: [],
  };
}

function buildService(isTerminal: boolean) {
  const tx = {
    enrollments: { update: jest.fn().mockResolvedValue({}) },
    students: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    enrollments: { findMany: jest.fn().mockResolvedValue([enrollment(isTerminal)]) },
    progression_rules: { findMany: jest.fn().mockResolvedValue([RULE]) },
    // confirm applies its writes inside one interactive transaction.
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PromotionService(
    prisma as unknown as ConstructorParameters<typeof PromotionService>[0],
    audit as unknown as AuditService,
  );
  return { service, tx };
}

// No target year, so nobody is moved forward — the graduation write is isolated.
const DTO = {
  academicYearId: 1,
  afterMakeup: false,
  enrollmentIds: ['enr1'],
} as unknown as ConfirmPromotionDto;

describe('PromotionService.confirm — graduation', () => {
  it('marks the student graduated when a terminal level is cleared', async () => {
    const { service, tx } = buildService(true);

    const result = await service.confirm(DTO, ACTOR, HEAD);

    expect(result.graduated).toBe(1);
    expect(tx.students.update).toHaveBeenCalledWith({
      where: { id: 'stu1' },
      data: { status: 'graduated' },
    });
    // The enrolment itself is completed, as before.
    expect(tx.enrollments.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }),
    );
  });

  it('does not touch student status for a non-graduating decision', async () => {
    // A non-terminal clean level promotes, not graduates.
    const { service, tx } = buildService(false);

    const result = await service.confirm(DTO, ACTOR, HEAD);

    expect(result.graduated).toBe(0);
    expect(tx.students.update).not.toHaveBeenCalled();
  });
});
