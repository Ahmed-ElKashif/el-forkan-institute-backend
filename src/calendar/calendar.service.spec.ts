import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { CalendarService } from './calendar.service';
import type { UpdateAcademicYearDto } from './dto/calendar.schema';

const ACTOR: Actor = { userId: 'h1', ipAddress: '127.0.0.1' };

const YEAR = {
  id: 2,
  hijri_year: 1448,
  starts_on: new Date('2026-08-01'),
  ends_on: new Date('2027-06-01'),
  status: 'planned',
  terms: [],
};

/* Exactly one academic year is current. Setting a year `active` must close any
   other active year, so the whole app's "current year" is unambiguous. */
function buildService() {
  const tx = {
    academic_years: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ ...YEAR, status: 'active' }),
    },
  };
  const prisma = {
    academic_years: { findUniqueOrThrow: jest.fn().mockResolvedValue(YEAR) },
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CalendarService(
    prisma as unknown as ConstructorParameters<typeof CalendarService>[0],
    audit as unknown as AuditService,
  );
  return { service, tx };
}

describe('CalendarService.update — single current year', () => {
  it('closes the previously-active year when a year is set current', async () => {
    const { service, tx } = buildService();

    await service.update(2, { status: 'active' } as UpdateAcademicYearDto, ACTOR);

    expect(tx.academic_years.updateMany).toHaveBeenCalledWith({
      where: { status: 'active', id: { not: 2 } },
      data: expect.objectContaining({ status: 'closed' }),
    });
  });

  it('does not demote anyone when the status is not active', async () => {
    const { service, tx } = buildService();

    await service.update(2, { status: 'closed' } as UpdateAcademicYearDto, ACTOR);

    expect(tx.academic_years.updateMany).not.toHaveBeenCalled();
  });
});
