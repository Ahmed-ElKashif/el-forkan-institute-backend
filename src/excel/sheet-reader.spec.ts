import ExcelJS from 'exceljs';
import {
  genderForSheetName,
  mapColumns,
  mapSessionColumns,
  readDataRows,
  SheetLayoutError,
} from './sheet-reader';
import { loadWorkbook, WorkbookTooLargeError } from './workbook-loader';

const ROSTER_MATCHERS = [
  { key: 'serial', aliases: ['م'] },
  { key: 'name', aliases: ['الأسم', 'الاسم'], required: true },
  { key: 'markaz', aliases: ['المركز'] },
  { key: 'phone', aliases: ['رقم الهاتف'] },
];

/**
 * Builds a workbook shaped like the institute's real files (§6.1): three
 * title rows, a header row, a blank row 5, data from row 6 — and a
 * configurable starting column, which is the whole point (L1/L3 start at C,
 * PREP starts at F).
 */
async function buildRoster(options: {
  sheetName: string;
  startColumn: number;
  rows: string[][];
  sessionCount?: number;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName);

  sheet.getCell(1, 1).value = 'دورات الفرقان التثقيفية';
  sheet.getCell(2, 1).value = 'فرع أسوان';
  sheet.getCell(3, 1).value = '2026 / 1447';

  const headers = ['م', 'الأسم', 'المركز', 'رقم الهاتف'];
  headers.forEach((header, offset) => {
    sheet.getCell(4, options.startColumn + offset).value = header;
  });
  for (let session = 1; session <= (options.sessionCount ?? 0); session += 1) {
    sheet.getCell(4, options.startColumn + headers.length + session - 1).value =
      session;
  }

  options.rows.forEach((row, rowOffset) => {
    row.forEach((value, columnOffset) => {
      sheet.getCell(6 + rowOffset, options.startColumn + columnOffset).value =
        value;
    });
  });

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

describe('genderForSheetName', () => {
  it.each([
    ['إخوة', 'male'],
    ['أخوات', 'female'],
    // §6.1: "sometimes with a trailing space".
    ['إخوة ', 'male'],
    ['أخوات ', 'female'],
    ['اخوة', 'male'],
  ])('maps sheet %s to %s', (name, expected) => {
    expect(genderForSheetName(name)).toBe(expected);
  });

  it('returns null for a sheet that names neither', () => {
    expect(genderForSheetName('Sheet1')).toBeNull();
  });
});

describe('reading a real-shaped roster', () => {
  const rows = [
    ['1', 'أحمد مصطفى', 'إدفو', '01001234567'],
    ['2', 'محمود زكريا', 'كوم أمبو', ''],
  ];

  it('reads the L1/L3 layout that starts at column C', async () => {
    const buffer = await buildRoster({
      sheetName: 'إخوة',
      startColumn: 3,
      rows,
    });
    const [sheet] = await loadWorkbook(buffer);
    const columns = mapColumns(sheet.rows, ROSTER_MATCHERS);

    expect(
      readDataRows(sheet.rows, columns).map((row) => row.values.name),
    ).toEqual(['أحمد مصطفى', 'محمود زكريا']);
  });

  // §6.2's explicit warning: "A fixed-index parser silently mis-reads the PREP
  // file." Same data, same code, different starting column.
  it('reads the PREP layout that starts at column F identically', async () => {
    const buffer = await buildRoster({
      sheetName: 'أخوات',
      startColumn: 6,
      rows,
    });
    const [sheet] = await loadWorkbook(buffer);
    const columns = mapColumns(sheet.rows, ROSTER_MATCHERS);

    const parsed = readDataRows(sheet.rows, columns);
    expect(parsed.map((row) => row.values.name)).toEqual([
      'أحمد مصطفى',
      'محمود زكريا',
    ]);
    expect(parsed[0].values.markaz).toBe('إدفو');
    expect(parsed[0].values.phone).toBe('01001234567');
  });

  it('reports the worksheet row number so an error names the real row', async () => {
    const buffer = await buildRoster({
      sheetName: 'إخوة',
      startColumn: 3,
      rows,
    });
    const [sheet] = await loadWorkbook(buffer);
    const columns = mapColumns(sheet.rows, ROSTER_MATCHERS);

    expect(
      readDataRows(sheet.rows, columns).map((row) => row.rowNumber),
    ).toEqual([6, 7]);
  });

  it('skips blank spacing rows rather than reporting one error per line', async () => {
    const buffer = await buildRoster({
      sheetName: 'إخوة',
      startColumn: 3,
      rows: [rows[0], ['', '', '', ''], rows[1]],
    });
    const [sheet] = await loadWorkbook(buffer);
    const columns = mapColumns(sheet.rows, ROSTER_MATCHERS);

    expect(readDataRows(sheet.rows, columns)).toHaveLength(2);
  });

  it('finds the numbered session columns of the attendance grid', async () => {
    const buffer = await buildRoster({
      sheetName: 'إخوة',
      startColumn: 3,
      rows,
      sessionCount: 15,
    });
    const [sheet] = await loadWorkbook(buffer);
    const sessions = mapSessionColumns(sheet.rows);

    expect(sessions.size).toBe(15);
    expect(sessions.get(1)).toBe(6); // zero-based: column G
    expect(sessions.get(15)).toBe(20);
  });

  it('refuses a sheet with no name column instead of guessing one', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('إخوة');
    sheet.getCell(4, 1).value = 'المركز';
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    const [loaded] = await loadWorkbook(buffer);

    expect(() => mapColumns(loaded.rows, ROSTER_MATCHERS)).toThrow(
      SheetLayoutError,
    );
  });
});

// §9: "cap file size and row count, parse with a timeout".
describe('loadWorkbook limits', () => {
  it('refuses a file over the size cap before parsing it', async () => {
    await expect(
      loadWorkbook(Buffer.alloc(64), { maxBytes: 32 }),
    ).rejects.toThrow(WorkbookTooLargeError);
  });

  it('rejects a buffer that is not a workbook at all', async () => {
    await expect(
      loadWorkbook(Buffer.from('not a zip archive')),
    ).rejects.toThrow();
  });
});
