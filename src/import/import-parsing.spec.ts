import { normalizeArabic } from '../common/arabic';
import type { DataRow } from '../excel/sheet-reader';
import {
  ExistingStudent,
  parseResultRow,
  parseRosterRow,
} from './import-parsing';

function dataRow(values: Record<string, string>): DataRow {
  return { rowNumber: 6, values, raw: [] };
}

function existing(
  name: string,
  overrides: Partial<ExistingStudent> = {},
): Map<string, ExistingStudent> {
  return new Map([
    [
      normalizeArabic(name),
      {
        id: 'student-1',
        normalizedName: normalizeArabic(name),
        hasPhone: false,
        hasMarkaz: false,
        ...overrides,
      },
    ],
  ]);
}

const ALIASES = new Map([
  ['نحو', 8],
  ['بلاغه', 9],
  ['عقيده', 4],
  ['سيره', 11],
]);

describe('parseRosterRow', () => {
  it('creates a student the roster does not already contain', () => {
    const result = parseRosterRow(
      dataRow({ name: 'أحمد مصطفى', markaz: 'إدفو', phone: '01001234567' }),
      new Map(),
    );

    expect(result.action).toBe('create');
    expect(result.matchStudentId).toBeNull();
    expect(result.parsed.fullName).toBe('أحمد مصطفى');
  });

  // §6.2: "الأسم → students.full_name (required — reject row if empty)".
  it.each([
    ['an empty name', ''],
    ['whitespace only', '   '],
  ])('rejects a row with %s', (_label, name) => {
    const result = parseRosterRow(dataRow({ name }), new Map());

    expect(result.action).toBe('error');
    expect(result.error).toBe('Row has no name');
  });

  // The two spellings in one real file (§6.2) must match the same student.
  it('matches an existing student across a spelling variant', () => {
    const result = parseRosterRow(
      dataRow({ name: 'رقيه رمضان' }),
      existing('رقية رمضان'),
    );

    expect(result.matchStudentId).toBe('student-1');
  });

  // §6.4: teachers fill phone and markaz manually afterwards, so a re-import
  // that brings one is worth applying — and one that brings nothing is not.
  it('updates when the sheet supplies a phone the student lacks', () => {
    const result = parseRosterRow(
      dataRow({ name: 'أحمد مصطفى', phone: '01001234567' }),
      existing('أحمد مصطفى'),
    );

    expect(result.action).toBe('update');
  });

  it('updates when the sheet supplies a markaz the student lacks', () => {
    const result = parseRosterRow(
      dataRow({ name: 'أحمد مصطفى', markaz: 'إدفو' }),
      existing('أحمد مصطفى'),
    );

    expect(result.action).toBe('update');
  });

  it('skips a row that would overwrite nothing', () => {
    const result = parseRosterRow(
      dataRow({ name: 'أحمد مصطفى', phone: '01001234567', markaz: 'إدفو' }),
      existing('أحمد مصطفى', { hasPhone: true, hasMarkaz: true }),
    );

    expect(result.action).toBe('skip');
  });

  // Re-importing the same names-only file must be a no-op, not 96 duplicates.
  it('skips a names-only row for a student already on file', () => {
    const result = parseRosterRow(
      dataRow({ name: 'أحمد مصطفى' }),
      existing('أحمد مصطفى'),
    );

    expect(result.action).toBe('skip');
  });
});

describe('parseResultRow', () => {
  const students = existing('إبراهيم أسامة شاذلى');

  it('reads a clean pass', () => {
    const result = parseResultRow(
      dataRow({ name: 'إبراهيم أسامة شاذلى', decision: 'إجتاز المستوى' }),
      students,
      ALIASES,
    );

    expect(result.action).toBe('update');
    expect(result.parsed.decision).toBe('promote');
    expect(result.parsed.carrySubjectIds).toEqual([]);
  });

  it('reads a pass with carried subjects and resolves them', () => {
    const result = parseResultRow(
      dataRow({
        name: 'إبراهيم أسامة شاذلى',
        decision: 'إجتاز المستوى بمواد',
        carrySubjects: 'نحو / عقيدة',
      }),
      students,
      ALIASES,
    );

    expect(result.parsed.decision).toBe('promote_with_carry');
    expect(result.parsed.carrySubjectIds).toEqual([8, 4]);
  });

  // §4.6 / §6.1: the L3 أخوات sheet has «مواد من المستوى الثانى» beside the
  // level's own carry column, proving carries survive more than one promotion.
  it('merges the previous level’s carry column into the same carry list', () => {
    const result = parseResultRow(
      dataRow({
        name: 'إبراهيم أسامة شاذلى',
        decision: 'إجتاز المستوى بمواد',
        carrySubjects: 'نحو',
        priorLevelSubjects: 'بلاغة',
      }),
      students,
      ALIASES,
    );

    expect(result.parsed.carrySubjectIds).toEqual([8, 9]);
  });

  it('reads a failure and its repeat subjects', () => {
    const result = parseResultRow(
      dataRow({
        name: 'إبراهيم أسامة شاذلى',
        decision: 'لم يجتاز المستوى',
        repeatSubjects: 'نحو، سيرة',
      }),
      students,
      ALIASES,
    );

    expect(result.parsed.decision).toBe('repeat');
    expect(result.parsed.repeatSubjectIds).toEqual([8, 11]);
  });

  // §6.3: the real L3 أخوات sheet has 18 outcome rows with no names.
  it('flags an outcome row with no name instead of guessing whose it is', () => {
    const result = parseResultRow(
      dataRow({ name: '', decision: 'إجتاز المستوى' }),
      students,
      ALIASES,
    );

    expect(result.action).toBe('error');
    expect(result.error).toContain('no name');
  });

  it('flags a name that matches no enrolled student', () => {
    const result = parseResultRow(
      dataRow({ name: 'شخص غير مسجل', decision: 'إجتاز المستوى' }),
      students,
      ALIASES,
    );

    expect(result.action).toBe('error');
    expect(result.error).toContain('import the roster first');
  });

  it('flags an unreadable decision rather than defaulting it', () => {
    const result = parseResultRow(
      dataRow({ name: 'إبراهيم أسامة شاذلى', decision: 'غير واضح' }),
      students,
      ALIASES,
    );

    expect(result.action).toBe('error');
    expect(result.error).toContain('Unrecognised decision');
  });

  // §6.2: "An unresolved token flags the row for review — never auto-create a
  // subject." Importing the rest would understate what the student still owes.
  it('flags the whole row when one carried subject cannot be resolved', () => {
    const result = parseResultRow(
      dataRow({
        name: 'إبراهيم أسامة شاذلى',
        decision: 'إجتاز المستوى بمواد',
        carrySubjects: 'نحو / مادة مجهولة',
      }),
      students,
      ALIASES,
    );

    expect(result.action).toBe('error');
    expect(result.error).toContain('مادة مجهولة');
    expect(result.parsed.unresolvedTokens).toEqual(['مادة مجهولة']);
  });

  it('sees through tatweel padding in the decision column', () => {
    const result = parseResultRow(
      dataRow({
        name: 'إبراهيم أسامة شاذلى',
        decision: 'إجــتــاز الــمســتــوى',
      }),
      students,
      ALIASES,
    );

    expect(result.parsed.decision).toBe('promote');
  });
});
