import {
  buildRosterWorkbook,
  EXPORT_FIRST_DATA_ROW,
  WorkbookSpec,
} from './roster-writer';
import { mapColumns, readDataRows } from './sheet-reader';
import { loadWorkbook } from './workbook-loader';

const SPEC: WorkbookSpec = {
  instituteName: 'دورات الفرقان التثقيفية',
  branchName: 'فرع أسوان',
  title: '2026 / 1447',
  sheets: [
    {
      name: 'إخوة',
      headers: ['م', 'الأسم', 'المركز', 'رقم الهاتف'],
      rows: [
        ['1', 'أحمد مصطفى', 'إدفو', '+201001234567'],
        ['2', 'محمود زكريا', 'كوم أمبو', ''],
      ],
    },
    { name: 'أخوات', headers: ['م', 'الأسم'], rows: [['1', 'رقية رمضان']] },
  ],
};

describe('buildRosterWorkbook', () => {
  it('writes one sheet per gender, named as the institute names them', async () => {
    const sheets = await loadWorkbook(await buildRosterWorkbook(SPEC));

    expect(sheets.map((sheet) => sheet.name)).toEqual(['إخوة', 'أخوات']);
  });

  it('puts the institute, branch and year in rows 1-3', async () => {
    const [sheet] = await loadWorkbook(await buildRosterWorkbook(SPEC));

    expect(sheet.rows[0][0]).toBe('دورات الفرقان التثقيفية');
    expect(sheet.rows[1][0]).toBe('فرع أسوان');
    expect(sheet.rows[2][0]).toBe('2026 / 1447');
  });

  it('starts the data at row 6, as the printed sheets do', async () => {
    const [sheet] = await loadWorkbook(await buildRosterWorkbook(SPEC));

    expect(sheet.rows[EXPORT_FIRST_DATA_ROW - 1][1]).toBe('أحمد مصطفى');
    // Row 5 is blank between the header and the data (§6.1).
    expect((sheet.rows[4] ?? []).join('')).toBe('');
  });

  // The layout has to survive its own round trip, or the institute cannot
  // export a roster, correct it in Excel, and import it back.
  it('produces a file this codebase can read back', async () => {
    const [sheet] = await loadWorkbook(await buildRosterWorkbook(SPEC));
    const columns = mapColumns(sheet.rows, [
      { key: 'name', aliases: ['الأسم'], required: true },
      { key: 'markaz', aliases: ['المركز'] },
    ]);

    const parsed = readDataRows(sheet.rows, columns);
    expect(parsed.map((row) => row.values.name)).toEqual([
      'أحمد مصطفى',
      'محمود زكريا',
    ]);
    expect(parsed[0].values.markaz).toBe('إدفو');
  });
});

// §6.5. The guard is the reason this function exists rather than callers
// writing cells directly.
describe('buildRosterWorkbook — CSV injection guard', () => {
  it('neutralises a formula planted in a student name', async () => {
    const workbook = await buildRosterWorkbook({
      ...SPEC,
      sheets: [
        {
          name: 'إخوة',
          headers: ['الأسم'],
          rows: [['=cmd|"/c calc"!A0']],
        },
      ],
    });
    const [sheet] = await loadWorkbook(workbook);

    expect(sheet.rows[EXPORT_FIRST_DATA_ROW - 1][0]).toBe(
      '\'=cmd|"/c calc"!A0',
    );
  });

  // E.164 phone numbers start with '+', which Excel treats as a formula.
  it('neutralises a leading + on a phone number', async () => {
    const [sheet] = await loadWorkbook(await buildRosterWorkbook(SPEC));

    expect(sheet.rows[EXPORT_FIRST_DATA_ROW - 1][3]).toBe("'+201001234567");
  });

  it('leaves ordinary Arabic text untouched', async () => {
    const [sheet] = await loadWorkbook(await buildRosterWorkbook(SPEC));

    expect(sheet.rows[EXPORT_FIRST_DATA_ROW - 1][1]).toBe('أحمد مصطفى');
    expect(sheet.rows[EXPORT_FIRST_DATA_ROW - 1][1]).not.toContain("'");
  });
});
