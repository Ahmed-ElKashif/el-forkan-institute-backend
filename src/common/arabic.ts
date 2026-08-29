// Spec §6.2: "strip tashkeel, ة→ه, أإآ→ا, ى→ي, collapse whitespace."
// The real sheets contain both سيرة and سيره in one file, and decision strings
// padded with tatweel (إجـــتـــاز), so matching raw text fails on data the
// institute already has. Every lookup that compares Arabic user text — subject
// aliases now, the Excel import later — goes through this first.

// U+064B..U+065F  harakat and tanween
// U+0670          superscript alef
// U+06D6..U+06ED  Quranic annotation marks
// U+0640          tatweel / kashida (a stretching glyph, never a letter)
const DIACRITICS_AND_TATWEEL = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

const LETTER_FOLDINGS: ReadonlyArray<[RegExp, string]> = [
  [/[\u0623\u0625\u0622\u0671]/g, '\u0627'], // أ إ آ ٱ  → ا
  [/\u0629/g, '\u0647'], // ة → ه
  [/\u0649/g, '\u064A'], // ى → ي
  [/\u0624/g, '\u0648'], // ؤ → و
  [/\u0626/g, '\u064A'], // ئ → ي
];

// Arabic-Indic (٠-٩) and extended Arabic-Indic (۰-۹) digits share code point
// order with ASCII 0-9, so the offset arithmetic below is exact.
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

export function normalizeArabic(input: string): string {
  return input
    .normalize('NFKC')
    .replace(DIACRITICS_AND_TATWEEL, '')
    .replace(ARABIC_INDIC_DIGITS, toLatinDigit)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '') // bidi/zero-width
    .replace(LETTER_FOLDINGS[0][0], LETTER_FOLDINGS[0][1])
    .replace(LETTER_FOLDINGS[1][0], LETTER_FOLDINGS[1][1])
    .replace(LETTER_FOLDINGS[2][0], LETTER_FOLDINGS[2][1])
    .replace(LETTER_FOLDINGS[3][0], LETTER_FOLDINGS[3][1])
    .replace(LETTER_FOLDINGS[4][0], LETTER_FOLDINGS[4][1])
    .replace(/\s+/g, ' ')
    .trim();
}

function toLatinDigit(digit: string): string {
  const code = digit.codePointAt(0) as number;
  const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
  return String.fromCharCode(0x30 + (code - base));
}
