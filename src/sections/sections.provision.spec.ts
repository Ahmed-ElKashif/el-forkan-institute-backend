import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditService } from '../common/audit.service';
import type { Actor } from '../common/actor.decorator';
import { SectionsService } from './sections.service';
import type { CreateSectionDto } from './dto/section.schema';

/* R1 × R3: six levels, two genders, one class each — twelve, and never a
   thirteenth. These pin the two halves of that rule: provisioning creates the
   set and is safe to re-run, and a manual create that would add a second class
   to a level is refused in words the head teacher can act on.

   Mocked at the boundaries only: Prisma is the database, AuditService writes
   to it. */

const ACTOR: Actor = { userId: 'h1' };

/** The institute's ladder as spec R1 names it — six levels, no L5. */
const LEVELS = [
  { id: 1, name_ar: 'المستوى التمهيدي' },
  { id: 2, name_ar: 'المستوى الأول' },
  { id: 3, name_ar: 'المستوى الثاني' },
  { id: 4, name_ar: 'المستوى الثالث' },
  { id: 5, name_ar: 'المستوى الرابع' },
  { id: 6, name_ar: 'المستوى الختامي' },
];

function buildService() {
  const prisma = {
    levels: { findMany: jest.fn().mockResolvedValue(LEVELS) },
    sections: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'new' }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SectionsService(
    prisma as unknown as ConstructorParameters<typeof SectionsService>[0],
    audit as unknown as AuditService,
  );
  return { service, prisma, audit };
}

describe('SectionsService.provisionYear', () => {
  it('creates one class per level per gender — twelve for six levels', async () => {
    const { service, prisma } = buildService();

    const out = await service.provisionYear(1, 1, ACTOR);

    expect(out).toEqual({ created: 12, total: 12 });
    expect(prisma.sections.create).toHaveBeenCalledTimes(12);
  });

  it('names classes with the roster wording the import and export sheets use', async () => {
    const { service, prisma } = buildService();

    await service.provisionYear(1, 1, ACTOR);

    const names = prisma.sections.create.mock.calls.map(
      (call: [{ data: { name: string } }]) => call[0].data.name,
    );
    expect(names).toContain('المستوى الأول — إخوة');
    expect(names).toContain('المستوى الأول — أخوات');
  });

  it('creates nothing on a second run, leaving existing classes untouched', async () => {
    const { service, prisma } = buildService();
    // Every class already exists — the head teacher may have renamed some, and
    // provisioning must not undo that.
    prisma.sections.findFirst.mockResolvedValue({ id: 'existing' });

    const out = await service.provisionYear(1, 1, ACTOR);

    expect(out).toEqual({ created: 0, total: 12 });
    expect(prisma.sections.create).not.toHaveBeenCalled();
  });

  it('treats a lost race as success rather than failing the whole run', async () => {
    const { service, prisma } = buildService();
    // Two head teachers pressing provision at once: the unique key rejects the
    // duplicate, but the class the caller wanted now exists either way.
    prisma.sections.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );

    const out = await service.provisionYear(1, 1, ACTOR);

    expect(out).toEqual({ created: 11, total: 12 });
  });

  it('provisions only the branch it was given', async () => {
    const { service, prisma } = buildService();

    await service.provisionYear(3, 7, ACTOR);

    for (const call of prisma.sections.create.mock.calls as [
      { data: { branch_id: number; academic_year_id: number } },
    ][]) {
      expect(call[0].data.branch_id).toBe(7);
      expect(call[0].data.academic_year_id).toBe(3);
    }
  });
});

describe('SectionsService.create', () => {
  it('refuses a second class for a level in words the head teacher can act on', async () => {
    const { service, prisma } = buildService();
    prisma.sections.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );

    const dto = {
      branchId: 1,
      academicYearId: 1,
      levelId: 2,
      gender: 'male',
      name: 'شعبة ب',
      defaultMode: 'onsite',
      supervisorId: null,
      whatsappGroupId: null,
      capacity: null,
    } as CreateSectionDto;

    await expect(service.create(dto, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
