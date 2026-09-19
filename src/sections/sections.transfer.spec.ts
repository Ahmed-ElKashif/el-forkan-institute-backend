import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SectionsService } from './sections.service';

const VIEWER: AuthenticatedUser = { id: 'v', role: 'head_teacher', branchId: null };
const ACTOR: Actor = { userId: 'v', ipAddress: '127.0.0.1' };

const ENROLLMENT = {
  id: 'e1',
  student_id: 's1',
  section_id: 'sec1',
  academic_year_id: 1,
  branch_id: 1,
  gender: 'male',
  entry_type: 'new',
  status: 'active',
  default_attendance_mode: 'onsite',
  final_decision: null,
  is_historical: false,
  student: { full_name: 'أحمد سالم' },
};

const SECTIONS: Record<string, unknown> = {
  sec1: { id: 'sec1', branch_id: 1, academic_year_id: 1, level_id: 1, gender: 'male', name: 'قسم أ', section_teachers: [] },
  sec2: { id: 'sec2', branch_id: 1, academic_year_id: 1, level_id: 2, gender: 'male', name: 'قسم ب', section_teachers: [] },
  sec3: { id: 'sec3', branch_id: 1, academic_year_id: 2, level_id: 2, gender: 'male', name: 'قسم عام آخر', section_teachers: [] },
  sec4: { id: 'sec4', branch_id: 1, academic_year_id: 1, level_id: 2, gender: 'female', name: 'قسم بنات', section_teachers: [] },
};

/* The "wrong study year" correction moves an enrollment to another section.
   Mocked at the Prisma/audit boundary; the assertions are the guards the service
   owns — same academic year, same gender — and that a valid move updates. */
function buildService() {
  const prisma = {
    enrollments: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(ENROLLMENT),
      update: jest.fn().mockImplementation(({ data }: { data: { section_id: string } }) =>
        Promise.resolve({ ...ENROLLMENT, section_id: data.section_id }),
      ),
    },
    sections: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(SECTIONS[where.id])),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SectionsService(
    prisma as unknown as ConstructorParameters<typeof SectionsService>[0],
    audit as unknown as ConstructorParameters<typeof SectionsService>[1],
  );
  return { service, prisma };
}

describe('SectionsService.transferEnrollment', () => {
  it('moves the enrollment to a section of another level in the same year', async () => {
    const { service, prisma } = buildService();

    const result = await service.transferEnrollment('e1', { sectionId: 'sec2' }, ACTOR, VIEWER);

    expect(prisma.enrollments.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'e1' }, data: { section_id: 'sec2', branch_id: 1 } }),
    );
    expect(result.sectionId).toBe('sec2');
  });

  it('refuses a move to a different academic year', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.transferEnrollment('e1', { sectionId: 'sec3' }, ACTOR, VIEWER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.enrollments.update).not.toHaveBeenCalled();
  });

  it('refuses a move that would cross the gender segregation (R3)', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.transferEnrollment('e1', { sectionId: 'sec4' }, ACTOR, VIEWER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.enrollments.update).not.toHaveBeenCalled();
  });
});
