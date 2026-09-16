import type { AuditService } from '../common/audit.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AttendanceService } from './attendance.service';

/* The grid reads either a whole term (the printed 1…15 sheet) or a single class
   day (one Friday's periods). This pins which sessions the query asks for in
   each case — the wrong window would show the wrong day's attendance. Prisma is
   stubbed at the boundary; the where-clause it receives is the behaviour. */

const VIEWER: AuthenticatedUser = { id: 'h1', role: 'head_teacher', branchId: null };
const TERM = {
  starts_on: new Date('2026-09-01T00:00:00Z'),
  ends_on: new Date('2026-12-01T00:00:00Z'),
};

function buildService() {
  const sessionsFindMany = jest.fn();
  const prisma = {
    sections: {
      findUnique: jest.fn().mockResolvedValue({ branch_id: 1, section_teachers: [] }),
    },
    terms: { findUniqueOrThrow: jest.fn().mockResolvedValue(TERM) },
    sessions: { findMany: sessionsFindMany },
    enrollments: { findMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([[], []]),
  };
  const audit = { record: jest.fn() };
  const service = new AttendanceService(
    prisma as unknown as ConstructorParameters<typeof AttendanceService>[0],
    audit as unknown as AuditService,
  );
  return { service, sessionsFindMany };
}

describe('AttendanceService.getGrid — session window', () => {
  it('narrows the columns to one calendar day when a date is given', async () => {
    const built = buildService();
    const date = new Date('2026-09-18T00:00:00Z');

    await built.service.getGrid('sec-1', { termId: 1, date }, VIEWER);

    expect(built.sessionsFindMany.mock.calls[0][0].where.session_date).toEqual(date);
  });

  it('spans the whole term when no date is given', async () => {
    const built = buildService();

    await built.service.getGrid('sec-1', { termId: 1 }, VIEWER);

    expect(built.sessionsFindMany.mock.calls[0][0].where.session_date).toEqual({
      gte: TERM.starts_on,
      lte: TERM.ends_on,
    });
  });
});
