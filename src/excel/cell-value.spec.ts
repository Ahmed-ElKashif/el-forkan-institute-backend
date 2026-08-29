import { cellToString, guardExportedCell } from './cell-value';

describe('cellToString — plain values', () => {
  it.each([
    ['a string', 'أحمد', 'أحمد'],
    ['a number', 42, '42'],
    ['zero', 0, '0'],
    ['a boolean', true, 'true'],
    ['null', null, ''],
    ['undefined', undefined, ''],
  ])('reads %s', (_label, input, expected) => {
    expect(cellToString(input)).toBe(expected);
  });

  it('reads a date as a calendar day', () => {
    expect(cellToString(new Date('2026-04-03T00:00:00Z'))).toBe('2026-04-03');
  });
});

// Spec §9 / §7.1: the import path receives files from teachers' laptops, and
// reading a formula rather than its cached result is what makes a crafted
// workbook dangerous.
describe('cellToString — formulas are never evaluated', () => {
  it('reads the cached result, not the formula text', () => {
    expect(cellToString({ formula: 'SUM(A1:A9)', result: 17 })).toBe('17');
  });

  it('reads a shared formula the same way', () => {
    expect(cellToString({ sharedFormula: 'A1', result: 'أحمد' })).toBe('أحمد');
  });

  it('never returns the formula text itself', () => {
    const evil = { formula: 'HYPERLINK("http://evil","click")', result: 'ok' };

    expect(cellToString(evil)).toBe('ok');
    expect(cellToString(evil)).not.toContain('HYPERLINK');
  });

  // An uncached formula must read as empty so the row is flagged in the
  // preview, rather than as a zero that quietly enters the database.
  it('reads an uncached formula as empty rather than guessing', () => {
    expect(cellToString({ formula: 'SUM(A1:A9)' })).toBe('');
  });

  it('reads an error cell as empty', () => {
    expect(cellToString({ error: '#REF!' })).toBe('');
  });
});

describe('cellToString — composite cell types', () => {
  it('joins rich-text runs into one string', () => {
    expect(
      cellToString({
        richText: [{ text: 'اللغة ' }, { text: 'العربية' }],
      }),
    ).toBe('اللغة العربية');
  });

  it('reads a hyperlink cell as its visible text, not its target', () => {
    const cell = { text: 'الكشف', hyperlink: 'http://example.test' };

    expect(cellToString(cell)).toBe('الكشف');
    expect(cellToString(cell)).not.toContain('http');
  });
});

// Spec §6.5. The victim of this bug is the head teacher opening her own
// roster, so the guard runs on every exported cell.
describe('guardExportedCell — CSV injection', () => {
  it.each([
    ['equals', '=1+1'],
    ['plus', '+1'],
    ['minus', '-1+1'],
    ['at sign', '@SUM(A1)'],
    ['tab', '\tcmd'],
    ['carriage return', '\rcmd'],
    ['the classic DDE payload', '=cmd|"/c calc"!A0'],
  ])('prefixes a cell starting with %s', (_label, input) => {
    expect(guardExportedCell(input)).toBe(`'${input}`);
  });

  it.each([
    ['an Arabic name', 'أحمد مصطفى'],
    ['a plain number', '95'],
    ['empty', ''],
    ['a name containing an equals sign', 'a=b'],
  ])('leaves %s untouched', (_label, input) => {
    expect(guardExportedCell(input)).toBe(input);
  });

  // A phone number in E.164 starts with '+', which IS a formula trigger.
  // Prefixing it is correct: the alternative is Excel evaluating it.
  it('prefixes an E.164 phone number, because Excel would evaluate it', () => {
    expect(guardExportedCell('+201001234567')).toBe("'+201001234567");
  });
});
