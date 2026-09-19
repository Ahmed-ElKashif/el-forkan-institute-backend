import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SectionsService } from './sections.service';
import type { ListEnrollmentsQueryDto } from './dto/section.schema';

const VIEWER: AuthenticatedUser = { id: 'v', role: 'head_teacher', branchId: null };

const ENROLLMENT = {
  id: 'e1',
  student_id: 's1',
  section_id: 'sec1',
  academic_year_id: 1,
  branch_id: 1,
  gender: 'male',
  entry_type: 'promoted_with_carry',
  status: 'active',
  default_attendance_mode: 'onsite',
  final_decision: null,
  is_historical: false,
  student: { full_name: 'أحمد سالم' },
};

/* The roster surfaces how many subjects each enrolment still owes from an
   earlier level. The count comes from one grouped read merged onto the page, so
   the assertions are that the merge attaches the right number, and zero when the
   student owes nothing. Mocked at the Prisma boundary. */
function buildService(carryGroups: Array<{ enrollment_id: string; _count: { _all: number } }>) {
  const prisma = {
    $transaction: jest.fn().mockResolvedValue([[ENROLLMENT], 1]),
    enrollments: {
      findMany: jest.fn().mockReturnValue({}),
      count: jest.fn().mockReturnValue({}),
    },
    carried_subjects: { groupBy: jest.fn().mockResolvedValue(carryGroups) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SectionsService(
    prisma as unknown as ConstructorParameters<typeof SectionsService>[0],
    audit as unknown as ConstructorParameters<typeof SectionsService>[1],
  );
  return { service, prisma };
}

const QUERY = { sectionId: 'sec1', page: 1, pageSize: 20 } as unknown as ListEnrollmentsQueryDto;

describe('SectionsService.listEnrollments — pending carries', () => {
  it('attaches the pending-carry count to the enrolment that owes them', async () => {
    const { service, prisma } = buildService([{ enrollment_id: 'e1', _count: { _all: 2 } }]);

    const page = await service.listEnrollments(QUERY, VIEWER);

    expect(page.items[0].pendingCarryCount).toBe(2);
    // Only pending carries for the page's enrolments are counted.
    expect(prisma.carried_subjects.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['enrollment_id'],
        where: { status: 'pending', enrollment_id: { in: ['e1'] } },
      }),
    );
  });

  it('reports zero for an enrolment with no pending carries', async () => {
    const { service } = buildService([]);

    const page = await service.listEnrollments(QUERY, VIEWER);

    expect(page.items[0].pendingCarryCount).toBe(0);
  });
});
