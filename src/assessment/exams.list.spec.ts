import type { AuditService } from '../common/audit.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ExamsService } from './exams.service';
import type { ListExamsQueryDto } from './dto/assessment.schema';

/* Date-first score entry lists the exams sitting on one day. This pins the
   window the list query asks for: a calendar day maps to [midnight, next
   midnight) on scheduled_at. Prisma stubbed at the boundary. */

const VIEWER: AuthenticatedUser = { id: 'h1', role: 'head_teacher', branchId: null };

function buildService() {
  const examsFindMany = jest.fn().mockReturnValue([]);
  const prisma = {
    exams: { findMany: examsFindMany, count: jest.fn().mockReturnValue(0) },
    $transaction: jest.fn().mockResolvedValue([[], 0]),
  };
  const audit = { record: jest.fn() };
  const service = new ExamsService(
    prisma as unknown as ConstructorParameters<typeof ExamsService>[0],
    audit as unknown as AuditService,
  );
  return { service, examsFindMany };
}

describe('ExamsService.list — date filter', () => {
  it('scopes to a single day as a half-open scheduled_at window', async () => {
    const built = buildService();

    await built.service.list(
      { date: new Date('2026-09-18T00:00:00Z'), page: 1, pageSize: 25 } as ListExamsQueryDto,
      VIEWER,
    );

    expect(built.examsFindMany.mock.calls[0][0].where.scheduled_at).toEqual({
      gte: new Date('2026-09-18T00:00:00Z'),
      lt: new Date('2026-09-19T00:00:00Z'),
    });
  });

  it('omits the scheduled_at window when no date is given', async () => {
    const built = buildService();

    await built.service.list({ page: 1, pageSize: 25 } as ListExamsQueryDto, VIEWER);

    expect(built.examsFindMany.mock.calls[0][0].where.scheduled_at).toBeUndefined();
  });
});
