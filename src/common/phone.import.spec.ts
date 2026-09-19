import { normalizeImportedPhone } from './phone';

/* §6.2 — phones as the institute's spreadsheets actually carry them.
 *
 * The import is a back-fill of numbers typed by many hands over years, so it
 * reads generously and normalises to the single E.164 form everything else
 * stores. It must never invent digits: every case below is a different way of
 * writing the same number, and the result still has to be a real number.
 *
 * `PhoneSchema` is the opposite contract and is deliberately not touched — what
 * a person types into the app is still rejected rather than coerced (§9). */

const CANONICAL = '+201012345678';

describe('normalizeImportedPhone — the same number, written many ways', () => {
  it.each([
    ['the national form', '01012345678'],
    [
      'Excel stored the cell as a number and ate the leading zero',
      '1012345678',
    ],
    ['already E.164', '+201012345678'],
    ['country code without the plus', '201012345678'],
    ['written-out international prefix', '00201012345678'],
    ['a trunk zero left in front of the country code', '0201012345678'],
    ['Arabic-Indic digits', '٠١٠١٢٣٤٥٦٧٨'],
    ['extended Arabic-Indic digits', '۰۱۰۱۲۳۴۵۶۷۸'],
    ['spaces', '010 1234 5678'],
    ['dashes', '010-1234-5678'],
    ['brackets', '(010) 1234 5678'],
    ['surrounding whitespace', '  01012345678  '],
    [
      'a leading apostrophe, which is what our own export writes',
      "'+201012345678",
    ],
    ['an apostrophe on the national form', "'01012345678"],
  ])('reads %s', (_label, written) => {
    expect(normalizeImportedPhone(written)).toBe(CANONICAL);
  });

  it.each([['010'], ['011'], ['012'], ['015']])(
    'accepts the %s mobile prefix',
    (prefix) => {
      expect(normalizeImportedPhone(`${prefix}12345678`)).toBe(
        `+20${prefix.slice(1)}12345678`,
      );
    },
  );

  /* The round trip that motivated this: our export prefixes `'` to any cell
     starting with `= + - @` as Excel's literal-text marker, so a downloaded
     roster carries `'+20…` in the raw cell. Re-importing it must recover the
     same number it exported. */
  it('recovers a number from a file this codebase exported', () => {
    const exported = `'${CANONICAL}`;

    expect(normalizeImportedPhone(exported)).toBe(CANONICAL);
  });
});

describe('normalizeImportedPhone — what it refuses', () => {
  it.each([
    ['blank', ''],
    ['whitespace only', '   '],
    ['no digits at all', 'لا يوجد'],
    ['far too short', '١٢٣'],
    ['far too long', '012345678901234567'],
  ])('returns null for %s', (_label, written) => {
    expect(normalizeImportedPhone(written)).toBeNull();
  });

  /* Null, not a throw: the roster is names-first, and losing a student over a
     malformed phone would block the back-fill the import exists to do. */
  it('never throws on rubbish', () => {
    expect(() => normalizeImportedPhone('=1+1')).not.toThrow();
    expect(normalizeImportedPhone('=1+1')).toBeNull();
  });
});

describe('normalizeImportedPhone — numbers that are not Egyptian', () => {
  /* The untouched original is tried first, so a valid foreign number is
     returned as itself rather than being rewritten into an Egyptian one. */
  it('keeps a Saudi number as a Saudi number', () => {
    expect(normalizeImportedPhone('+966512345678')).toBe('+966512345678');
  });

  it('keeps a UK number as a UK number', () => {
    expect(normalizeImportedPhone('+442071838750')).toBe('+442071838750');
  });
});
