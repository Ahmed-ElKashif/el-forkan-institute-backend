import { ArabicNameSchema } from './arabic-name.schema';

describe('ArabicNameSchema', () => {
  it.each([
    ['a single name', 'أحمد', 'أحمد'],
    ['a two-part name', 'أحمد مصطفى', 'أحمد مصطفى'],
    ['a hyphenated name', 'عبد-الله', 'عبد-الله'],
    ['surrounding whitespace it trims', '  سارة  ', 'سارة'],
  ])('accepts %s', (_label, input, expected) => {
    expect(ArabicNameSchema.parse(input)).toBe(expected);
  });

  // The point of the rule: a name is Arabic letters, not a data-entry dumping
  // ground. Digits (either script), Latin letters and symbols are rejected, so
  // "أحمد 139389" cannot enter as a name.
  it.each([
    ['a Latin digit', 'أحمد 139389'],
    ['Arabic-Indic digits', 'أحمد ١٢٣'],
    ['Latin letters', 'Ahmed'],
    ['a symbol', 'أحمد@'],
    ['a single character', 'أ'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => ArabicNameSchema.parse(input)).toThrow();
  });
});
