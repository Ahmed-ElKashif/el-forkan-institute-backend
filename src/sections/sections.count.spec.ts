import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SectionsService } from './sections.service';
import type { ListSectionsQueryDto } from './dto/section.schema';

const VIEWER: AuthenticatedUser = { id: 'v', role: 'head_teacher', branchId: null };

const SECTION = {
  id: 'sec1',
  name: 'المستوى الثاني — إخوة',
  branch_id: 1,
  academic_year_id: 1,
  level_id: 2,
  gender: 'male',
  default_mode: 'onsite',
  supervisor_id: null,
  whatsapp_group_id: null,
  capacity: null,
  section_teachers: [],
  _count: { enrollments: 0 },
};

/* `enrolledCount` is what the class picker and the roster tab badge show, and
   the roster itself lists ACTIVE members. Counting every enrolment row ever
   created made a class that had been promoted out report a full register above
   an empty table — 8 students on the badge, nobody on the roster. The count must
   therefore ask for active enrolments, not all of them. Mocked at the Prisma
   boundary, so this asserts the query shape the bug was hiding in. */
function buildService() {
  const prisma = {
    $transaction: jest.fn().mockResolvedValue([[SECTION], 1]),
    sections: {
      findMany: jest.fn().mockReturnValue({}),
      count: jest.fn().mockReturnValue({}),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SectionsService(
    prisma as unknown as ConstructorParameters<typeof SectionsService>[0],
    audit as unknown as ConstructorParameters<typeof SectionsService>[1],
  );
  return { service, prisma };
}

const QUERY = { page: 1, pageSize: 20 } as unknown as ListSectionsQueryDto;

describe('SectionsService.list — enrolledCount', () => {
  it('counts only active enrolments, not students who left or were promoted out', async () => {
    const { service, prisma } = buildService();

    await service.list(QUERY, VIEWER);

    expect(prisma.sections.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: { select: { enrollments: { where: { status: 'active' } } } },
        }),
      }),
    );
  });

  it('reports the active count it was given', async () => {
    const { service } = buildService();

    const page = await service.list(QUERY, VIEWER);

    expect(page.items[0].enrolledCount).toBe(0);
  });
});
