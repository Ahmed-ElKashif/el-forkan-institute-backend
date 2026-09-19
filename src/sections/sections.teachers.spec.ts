import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditService } from '../common/audit.service';
import type { Actor } from '../common/actor.decorator';
import { SectionsService } from './sections.service';
import type { AssignTeacherDto } from './dto/section.schema';

/* R3 covers staff as well as students: a class has one responsible teacher, and
   a level — being two classes — therefore has two, one per cohort.

   Neither rule is enforced in this service. Both live in the DDL: composite FKs
   `(user_id, gender) → users(id, gender)` and `(section_id, gender) →
   sections(id, gender)` reject a mismatched teacher, and the partial unique
   index `section_teachers_one_primary_per_section` rejects a second primary.
   What the service owes the head teacher is a message naming the rule that
   stopped them — a bare Prisma code tells them nothing about what to do next.

   Mocked at the boundaries only: Prisma is the database, AuditService writes
   to it. */

const ACTOR: Actor = { userId: 'h1' };
const DTO: AssignTeacherDto = { userId: 'u1', isPrimary: true };

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('db rejected it', {
    code,
    clientVersion: 'test',
  });
}

function buildService(rejectWith?: Error) {
  const create = rejectWith
    ? jest.fn().mockRejectedValue(rejectWith)
    : jest.fn().mockResolvedValue({});
  const prisma = {
    sections: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ gender: 'female' }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'sec1',
        gender: 'female',
        section_teachers: [],
        enrollments: [],
        levels: { name_ar: 'المستوى الثاني' },
      }),
    },
    section_teachers: { create },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new SectionsService(
    prisma as unknown as ConstructorParameters<typeof SectionsService>[0],
    audit as unknown as AuditService,
  );
  return { service, create, audit };
}

describe('SectionsService.assignTeacher', () => {
  it('stamps the class gender onto the row, which is what lets the DB reject a mismatch', async () => {
    const { service, create } = buildService();

    await service.assignTeacher('sec1', DTO, ACTOR).catch(() => undefined);

    expect(create).toHaveBeenCalledWith({
      data: {
        section_id: 'sec1',
        user_id: 'u1',
        gender: 'female',
        is_primary: true,
      },
    });
  });

  it('explains a gender mismatch instead of surfacing the foreign key', async () => {
    const { service } = buildService(prismaError('P2003'));

    await expect(service.assignTeacher('sec1', DTO, ACTOR)).rejects.toThrow(
      /only female teachers/,
    );
  });

  /* The second responsible teacher on the SAME class. This used to escape as an
     unmapped P2002 — "Unique constraint failed" — which reads as a crash rather
     than as the rule it is. A level gets its second responsible teacher from
     the other cohort's class, not from here. */
  it('explains a second primary on one class instead of surfacing P2002', async () => {
    const { service } = buildService(prismaError('P2002'));

    await expect(service.assignTeacher('sec1', DTO, ACTOR)).rejects.toThrow(
      ConflictException,
    );
    await expect(service.assignTeacher('sec1', DTO, ACTOR)).rejects.toThrow(
      /already has a responsible teacher/,
    );
  });

  it('lets an unrecognised database error through rather than mislabelling it', async () => {
    const { service } = buildService(prismaError('P2025'));

    await expect(service.assignTeacher('sec1', DTO, ACTOR)).rejects.not.toThrow(
      ConflictException,
    );
  });

  it('writes no audit row when the assignment was refused', async () => {
    const { service, audit } = buildService(prismaError('P2002'));

    await service.assignTeacher('sec1', DTO, ACTOR).catch(() => undefined);

    expect(audit.record).not.toHaveBeenCalled();
  });
});
