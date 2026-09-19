import { CatalogueService } from './catalogue.service';
import type { CreateSubjectDto, ListBooksQueryDto } from './dto/catalogue.schema';

/* Two behaviours the catalogue screen depends on.

   `subjects.code` is no longer asked for: nothing reads it (the Excel import
   resolves through `subject_aliases.normalized`), so the service invents one.
   The sequence must ignore hand-written codes — letting `NAHW` or `S_OLD` into
   the max would either crash the parse or skip the numbering forward.

   `GET /books` gained the two filters subjects already had; without the active
   filter the picker was handed inactive books and had to hide them itself. */

/* `transactionResult` is what `$transaction` resolves to, and the two callers
   want different shapes: the list paths batch [rows, total], while
   `removeSubject` batches the four reference counts. Passing it in keeps the
   stub honest instead of guessing from the call. */
function buildService(subjectCodes: string[], transactionResult: unknown = [[], 0]) {
  const prisma = {
    subjects: {
      findMany: jest
        .fn()
        .mockResolvedValue(subjectCodes.map((code) => ({ code }))),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 1, ...data, subject_aliases: [] }),
      ),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 1, code: 'S001', name_ar: 'النحو', short_name_ar: null, name_en: null, is_active: true, subject_aliases: [] }),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    curriculum: { count: jest.fn() },
    sessions: { count: jest.fn() },
    carried_subjects: { count: jest.fn() },
    timetable_slots: { count: jest.fn() },
    books: { findMany: jest.fn().mockReturnValue({}), count: jest.fn().mockReturnValue({}) },
    $transaction: jest.fn().mockResolvedValue(transactionResult),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CatalogueService(
    prisma as unknown as ConstructorParameters<typeof CatalogueService>[0],
    audit as unknown as ConstructorParameters<typeof CatalogueService>[1],
  );
  return { service, prisma };
}

const NEW_SUBJECT = { nameAr: 'النحو' } as CreateSubjectDto;

describe('CatalogueService.createSubject — generated codes', () => {
  it('starts at S001 when nothing is numbered yet', async () => {
    const { service, prisma } = buildService([]);

    await service.createSubject(NEW_SUBJECT, { userId: 'u' } as never);

    expect(prisma.subjects.create.mock.calls[0][0].data.code).toBe('S001');
  });

  it('continues from the highest generated code', async () => {
    const { service, prisma } = buildService(['S001', 'S009', 'S002']);

    await service.createSubject(NEW_SUBJECT, { userId: 'u' } as never);

    expect(prisma.subjects.create.mock.calls[0][0].data.code).toBe('S010');
  });

  it('ignores hand-written codes when numbering', async () => {
    // `SIRAH` starts with S but is not a generated code; parsing it would be
    // NaN, and treating it as one would move the sequence somewhere arbitrary.
    const { service, prisma } = buildService(['SIRAH', 'S003']);

    await service.createSubject(NEW_SUBJECT, { userId: 'u' } as never);

    expect(prisma.subjects.create.mock.calls[0][0].data.code).toBe('S004');
  });

  it('keeps a code the caller supplied', async () => {
    const { service, prisma } = buildService(['S001']);

    await service.createSubject(
      { ...NEW_SUBJECT, code: 'NAHW' } as CreateSubjectDto,
      { userId: 'u' } as never,
    );

    expect(prisma.subjects.create.mock.calls[0][0].data.code).toBe('NAHW');
  });
});

/* Deleting a subject is allowed only while nothing has used it — the mistyped
   entry that would otherwise sit in the registry for ever. Once it has been
   taught, `curriculum` / `sessions` / `carried_subjects` / `timetable_slots`
   point at it with ON DELETE RESTRICT, so the delete must be refused with an
   explanation rather than left to fail as a constraint error. */
describe('CatalogueService.removeSubject', () => {
  it('deletes a subject nothing references', async () => {
    const { service, prisma } = buildService([], [0, 0, 0, 0]);

    await service.removeSubject(1, { userId: 'u' } as never);

    expect(prisma.subjects.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('refuses one that is on the curriculum, and does not delete it', async () => {
    const { service, prisma } = buildService([], [2, 0, 0, 0]);

    await expect(service.removeSubject(1, { userId: 'u' } as never)).rejects.toThrow(/in use/);
    expect(prisma.subjects.delete).not.toHaveBeenCalled();
  });

  it('refuses one that is only referenced by a carried subject', async () => {
    // A student still owes it (R14), so it is history even with no curriculum row.
    const { service, prisma } = buildService([], [0, 0, 1, 0]);

    await expect(service.removeSubject(1, { userId: 'u' } as never)).rejects.toThrow(/in use/);
    expect(prisma.subjects.delete).not.toHaveBeenCalled();
  });
});

describe('CatalogueService.listBooks — filters', () => {
  it('hides inactive books unless asked for them', async () => {
    const { service, prisma } = buildService([]);

    await service.listBooks({ page: 1, pageSize: 25, includeInactive: false } as ListBooksQueryDto);

    expect(prisma.books.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true } }),
    );
  });

  it('searches title and author together', async () => {
    const { service, prisma } = buildService([]);

    await service.listBooks({
      page: 1,
      pageSize: 25,
      includeInactive: true,
      search: 'الروض',
    } as ListBooksQueryDto);

    expect(prisma.books.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { title_ar: { contains: 'الروض' } },
            { author_ar: { contains: 'الروض' } },
          ],
        },
      }),
    );
  });
});
