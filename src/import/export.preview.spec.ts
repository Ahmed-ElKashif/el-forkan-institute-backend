import type { AuditService } from '../common/audit.service';
import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ExportService } from './export.service';

/* §6.3 makes preview-then-commit mandatory for the import; the export is the
   same workbook going the other way. The property that matters is that the
   preview and the file are built by one builder — a preview showing different
   rows from the file it promises would be worse than no preview at all.

   Mocked at the boundaries only: Prisma is the database, AuditService writes
   to it. The workbook writer is real, so the download path still proves the
   sheets survive being written. */

const HEAD: AuthenticatedUser = {
  id: 'h1',
  role: 'head_teacher',
  branchId: null,
};
const TEACHER: AuthenticatedUser = { id: 't1', role: 'teacher', branchId: 1 };
const ACTOR: Actor = { userId: 'h1' };

/** Levels a carry can originate from, as `loadScope` now includes them — the
 *  origin level is what names the column the carry is printed in. */
const LEVELS: Record<
  number,
  { id: number; name_ar: string; sort_order: number }
> = {
  1: { id: 1, name_ar: 'المستوى الأول', sort_order: 1 },
  2: { id: 2, name_ar: 'المستوى الثاني', sort_order: 2 },
};

/** A pending carry: the subject owed and the level it was failed at. */
function carry(nameAr: string, originLevelId: number) {
  return {
    status: 'pending',
    origin_level_id: originLevelId,
    subjects: { name_ar: nameAr },
    levels: LEVELS[originLevelId],
  };
}

function enrollment(name: string, carries: ReturnType<typeof carry>[] = []) {
  return {
    final_decision: 'promote',
    student: {
      full_name: name,
      phone: '+201000000001',
      whatsapp_phone: null,
      markazes: { name_ar: 'مركز أسوان' },
    },
    carried_subjects_carried_subjects_enrollment_idToenrollments: carries,
  };
}

const SECTIONS = [
  {
    gender: 'male',
    enrollments: [enrollment('أحمد سالم', [carry('النحو', 1)])],
  },
  { gender: 'female', enrollments: [enrollment('فاطمة علي')] },
];

function buildService() {
  const prisma = {
    academic_years: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ hijri_year: 1447 }),
    },
    sections: { findMany: jest.fn().mockResolvedValue(SECTIONS) },
    institute_settings: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ name_ar: 'معهد الفرقان' }),
    },
    branches: { findFirst: jest.fn().mockResolvedValue({ name_ar: 'أسوان' }) },
    audit_logs: { create: jest.fn() },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ExportService(
    prisma as unknown as ConstructorParameters<typeof ExportService>[0],
    audit as unknown as AuditService,
  );
  return { service, prisma, audit };
}

describe('ExportService — preview', () => {
  it('shows one sheet per gender, with the carried subjects the roster prints', async () => {
    const { service } = buildService();

    const preview = await service.previewRoster(1, undefined, HEAD);

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual([
      'إخوة',
      'أخوات',
    ]);
    expect(preview.sheets[0].rows[0]).toEqual([
      '1',
      'أحمد سالم',
      'مركز أسوان',
      '+201000000001',
      'النحو',
    ]);
    expect(preview.rowCount).toBe(2);
  });

  it('promises exactly the rows the download then writes', async () => {
    // The one property worth having: both sides call the same builder, so a
    // change to either cannot silently drift from the other.
    const { service } = buildService();

    const preview = await service.previewRoster(1, undefined, HEAD);
    const downloaded = await service.exportRoster(1, undefined, ACTOR, HEAD);

    expect(downloaded.rowCount).toBe(preview.rowCount);
  });

  it('previews the result sheet with its own headers', async () => {
    const { service } = buildService();

    const preview = await service.previewResults(1, undefined, HEAD);

    expect(preview.sheets[0].headers).toEqual([
      'م',
      'الأسم',
      'النتيجة',
      'مواد من المستوى الأول',
    ]);
    expect(preview.sheets[0].rows[0]).toEqual([
      '1',
      'أحمد سالم',
      'إجتاز المستوى',
      'النحو',
    ]);
  });

  /* §6.1: the institute's sheets give each origin level its own column. A
     student owing subjects to two levels must not have them merged into one
     cell — the head teacher needs to see which level each debt belongs to, and
     the importer reads them back per column. */
  it('gives every origin level its own column, oldest first', async () => {
    const { service, prisma } = buildService();
    prisma.sections.findMany.mockResolvedValue([
      {
        gender: 'male',
        enrollments: [
          enrollment('أحمد سالم', [carry('النحو', 2), carry('الفقه', 1)]),
        ],
      },
      { gender: 'female', enrollments: [] },
    ]);

    const preview = await service.previewRoster(1, undefined, HEAD);

    expect(preview.sheets[0].headers).toEqual([
      'م',
      'الأسم',
      'المركز',
      'رقم الهاتف',
      'مواد من المستوى الأول',
      'مواد من المستوى الثاني',
    ]);
    expect(preview.sheets[0].rows[0].slice(4)).toEqual(['الفقه', 'النحو']);
  });

  /* An empty cell reads as a column somebody forgot to fill in; a placeholder
     reads as "owes nothing here", which is the fact. */
  it('prints a placeholder where a student owes that level nothing', async () => {
    const { service, prisma } = buildService();
    prisma.sections.findMany.mockResolvedValue([
      {
        gender: 'male',
        enrollments: [
          enrollment('أحمد سالم', [carry('الفقه', 1)]),
          enrollment('محمود زكريا', [carry('النحو', 2)]),
        ],
      },
      { gender: 'female', enrollments: [] },
    ]);

    const preview = await service.previewRoster(1, undefined, HEAD);

    expect(preview.sheets[0].rows[0].slice(4)).toEqual(['الفقه', '—']);
    expect(preview.sheets[0].rows[1].slice(4)).toEqual(['—', 'النحو']);
  });

  /* A cleared carry is settled debt. It must not create a column of its own,
     nor appear in one. */
  it('ignores cleared carries entirely', async () => {
    const { service, prisma } = buildService();
    prisma.sections.findMany.mockResolvedValue([
      {
        gender: 'male',
        enrollments: [
          enrollment('أحمد سالم', [
            { ...carry('الفقه', 1), status: 'cleared' },
          ]),
        ],
      },
      { gender: 'female', enrollments: [] },
    ]);

    const preview = await service.previewRoster(1, undefined, HEAD);

    expect(preview.sheets[0].headers).toEqual([
      'م',
      'الأسم',
      'المركز',
      'رقم الهاتف',
    ]);
  });

  it('writes no audit row — nothing has left the building yet', async () => {
    /* §9 says log every export, and it means the file. An audit row per preview
       would bury the real exports, which are the ones that matter. */
    const { service, audit } = buildService();

    await service.previewRoster(1, undefined, HEAD);
    await service.previewResults(1, undefined, HEAD);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits the download, as it always did', async () => {
    const { service, audit } = buildService();

    await service.exportRoster(1, undefined, ACTOR, HEAD);

    expect(audit.record).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ action: 'export.roster' }),
    );
  });

  it('scopes a preview to the teacher’s own sections, exactly like the download', async () => {
    const { service, prisma } = buildService();

    await service.previewRoster(1, 7, TEACHER);

    const [args] = prisma.sections.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toMatchObject({
      branch_id: 1,
      section_teachers: { some: { user_id: 't1' } },
      academic_year_id: 1,
      level_id: 7,
    });
  });
});
