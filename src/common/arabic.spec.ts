import { normalizeArabic } from './arabic';

describe('normalizeArabic', () => {
  // The pairs the institute's own files actually contain (spec §6.2).
  it.each([
    ['سيرة', 'سيره'],
    ['السيرة النبوية', 'السيره النبويه'],
    ['أصول الفقه', 'اصول الفقه'],
    ['إجتاز', 'اجتاز'],
    ['آداب', 'اداب'],
    ['مصطفى', 'مصطفي'],
  ])('folds %s to the same key as its spelling variant', (a, b) => {
    expect(normalizeArabic(a)).toBe(normalizeArabic(b));
  });

  it('strips tatweel padding used to justify printed cells', () => {
    // «إجـــتـــاز» is how the decision column is padded in the real sheets.
    expect(normalizeArabic('إجـــتـــاز')).toBe(normalizeArabic('إجتاز'));
  });

  it('strips tashkeel', () => {
    expect(normalizeArabic('الْقُرْآن')).toBe(normalizeArabic('القرآن'));
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(normalizeArabic('  اللغة   العربية \n')).toBe('اللغه العربيه');
  });

  it('converts Arabic-Indic digits so a level number matches either script', () => {
    expect(normalizeArabic('المستوى ٣')).toBe(normalizeArabic('المستوى 3'));
  });

  // Invisible characters survive copy-paste out of Word and Excel and would
  // otherwise make two identical-looking names hash to different keys.
  it('removes zero-width and bidi control characters', () => {
    expect(normalizeArabic('نحو\u200F')).toBe('نحو');
  });

  it.each([
    ['an empty string', '', ''],
    ['only whitespace', '   ', ''],
  ])('maps %s to an empty key', (_label, input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });

  it('leaves Latin text untouched', () => {
    expect(normalizeArabic('Level 3')).toBe('Level 3');
  });
});
