import type { AuditService } from '../common/audit.service';
import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ExportService } from './export.service';
import { RESULT_COLUMNS, ROSTER_COLUMNS } from './import.service';
import { mapColumns, readDataRows } from '../excel/sheet-reader';
import { loadWorkbook } from '../excel/workbook-loader';
import { resolveSubjects, splitSubjectList } from '../excel/result-parsing';
import { normalizeArabic } from '../common/arabic';
import { normalizeImportedPhone } from '../common/phone';

/* §6.5 — the export mirrors the layout the institute already prints, and the
   import reads that layout. The round trip is the property that ties them: a
   file this codebase writes must be a file this codebase can read back.

   That got sharper when carried subjects gained one column per origin level.
   `mapColumns` used to take the FIRST column matching a prefix and ignore the
   rest, so a three-level export would have re-imported as one level's debt with
   the other two silently dropped — the subtlest possible data loss. The
   `priorLevelSubjects` matcher is now `multiple`, and this spec is what proves
   it end to end rather than in principle.

   The workbook writer and reader are both real here. Only Prisma is mocked. */

const HEAD: AuthenticatedUser = {
  id: 'h1',
  role: 'head_teacher',
  branchId: null,
};
const ACTOR: Actor = { userId: 'h1' };

const LEVELS: Record<
  number,
  { id: number; name_ar: string; sort_order: number }
> = {
  1: { id: 1, name_ar: 'المستوى الأول', sort_order: 1 },
  2: { id: 2, name_ar: 'المستوى الثاني', sort_order: 2 },
  3: { id: 3, name_ar: 'المستوى الثالث', sort_order: 3 },
};

function carry(nameAr: string, originLevelId: number) {
  return {
    status: 'pending',
    origin_level_id: originLevelId,
    subjects: { name_ar: nameAr },
    levels: LEVELS[originLevelId],
  };
}

function enrollment(name: string, carries: ReturnType<typeof carry>[]) {
  return {
    final_decision: 'promote_with_carry',
    student: {
      full_name: name,
      phone: '+201000000001',
      whatsapp_phone: null,
      markazes: { name_ar: 'مركز أسوان' },
    },
    carried_subjects_carried_subjects_enrollment_idToenrollments: carries,
  };
}

/** One student owing subjects to three different levels at once — the case the
 *  old single-column reader could not survive. */
const SECTIONS = [
  {
    gender: 'male',
    enrollments: [
      enrollment('أحمد سالم', [
        carry('الفقه', 1),
        carry('النحو', 2),
        carry('العقيدة', 3),
      ]),
      enrollment('محمود زكريا', [carry('التفسير', 2)]),
    ],
  },
  { gender: 'female', enrollments: [] },
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
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return new ExportService(
    prisma as unknown as ConstructorParameters<typeof ExportService>[0],
    audit as unknown as AuditService,
  );
}

/** The alias map the importer resolves tokens against. */
const ALIASES = new Map<string, number>([
  [normalizeArabic('الفقه'), 1],
  [normalizeArabic('النحو'), 2],
  [normalizeArabic('العقيدة'), 3],
  [normalizeArabic('التفسير'), 4],
]);

describe('export → import round trip', () => {
  it('re-reads a roster it wrote, including every origin level column', async () => {
    const service = buildService();

    const file = await service.exportRoster(1, undefined, ACTOR, HEAD);
    const [sheet] = await loadWorkbook(file.buffer);
    const columns = mapColumns(sheet.rows, ROSTER_COLUMNS);
    const rows = readDataRows(sheet.rows, columns);

    expect(rows.map((row) => row.values.name)).toEqual([
      'أحمد سالم',
      'محمود زكريا',
    ]);
    expect(rows[0].values.markaz).toBe('مركز أسوان');

    /* `guardExportedCell` prefixes a `'` to any cell starting with `= + - @` —
     * Excel's literal-text marker, and the right CSV-injection guard. Excel
     * hides it, but ExcelJS reads the stored string back verbatim, so the raw
     * cell really does carry it. Asserting the raw form here keeps that visible
     * rather than surprising. */
    expect(rows[0].values.phone).toBe("'+201000000001");

    // What matters is that the importer still recovers the number it exported.
    expect(normalizeImportedPhone(rows[0].values.phone)).toBe('+201000000001');
  });

  /* The heart of it: three «مواد من المستوى …» columns go out, and all three
     come back as this student's debt. Reading only the first would understate
     what they owe, which §6.2 calls out as worse than failing the row. */
  it('re-reads every level of carried subjects, not just the first column', async () => {
    const service = buildService();

    const file = await service.exportResults(1, undefined, ACTOR, HEAD);
    const [sheet] = await loadWorkbook(file.buffer);

    // Three separate columns were written, one per origin level.
    const columns = mapColumns(sheet.rows, RESULT_COLUMNS);
    expect(columns.get('priorLevelSubjects')).toHaveLength(3);

    const [first] = readDataRows(sheet.rows, columns);
    const resolved = resolveSubjects(
      splitSubjectList(first.values.priorLevelSubjects),
      ALIASES,
    );

    expect(resolved.map((entry) => entry.token)).toEqual([
      'الفقه',
      'النحو',
      'العقيدة',
    ]);
    // Every token resolves, so the row would import cleanly rather than error.
    expect(resolved.every((entry) => entry.subjectId !== null)).toBe(true);
  });

  /* The placeholder is a display device, not data. It must not survive the
     round trip as a phantom subject that no alias resolves — which would turn
     a clean row into an error row. */
  it('does not read the empty-cell placeholder back as a subject', async () => {
    const service = buildService();

    const file = await service.exportResults(1, undefined, ACTOR, HEAD);
    const [sheet] = await loadWorkbook(file.buffer);
    const columns = mapColumns(sheet.rows, RESULT_COLUMNS);

    // The second student owes only level 2, so two of their three cells are '—'.
    const second = readDataRows(sheet.rows, columns)[1];
    const resolved = resolveSubjects(
      splitSubjectList(second.values.priorLevelSubjects),
      ALIASES,
    );

    expect(resolved.map((entry) => entry.token)).toEqual(['التفسير']);
  });

  it('still reads the decision column back as the importer understands it', async () => {
    const service = buildService();

    const file = await service.exportResults(1, undefined, ACTOR, HEAD);
    const [sheet] = await loadWorkbook(file.buffer);
    const columns = mapColumns(sheet.rows, RESULT_COLUMNS);

    expect(readDataRows(sheet.rows, columns)[0].values.decision).toBe(
      'إجتاز المستوى بمواد',
    );
  });
});
