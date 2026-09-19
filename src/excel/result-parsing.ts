import { normalizeArabic } from '../common/arabic';

/**
 * §6.2 — reading the decision column and the carry/repeat subject lists off
 * the real result sheets.
 *
 * Everything here compares *normalised* text: the decision strings are padded
 * with tatweel (`إجـــتـــاز`) to justify the printed cell, and the same file
 * contains both `سيرة` and `سيره`. Matching raw text fails on data the
 * institute already has.
 */

export type ImportedDecision = 'promote' | 'promote_with_carry' | 'repeat';

/**
 * Order matters: `إجتاز المستوى بمواد` contains `إجتاز المستوى` as a prefix,
 * so the more specific phrase has to be tested first or every
 * carry-with-subjects student would be read as a clean pass.
 */
const DECISION_PATTERNS: Array<{
  phrase: string;
  decision: ImportedDecision;
}> = [
  { phrase: 'إجتاز المستوى بمواد', decision: 'promote_with_carry' },
  { phrase: 'اجتاز بمواد', decision: 'promote_with_carry' },
  { phrase: 'لم يجتاز المستوى', decision: 'repeat' },
  { phrase: 'لم يجتاز', decision: 'repeat' },
  { phrase: 'إجتاز المستوى', decision: 'promote' },
  // PREP sheets record a bare «إجتاز» with no level word (§6.2).
  { phrase: 'إجتاز', decision: 'promote' },
];

const NORMALIZED_DECISIONS = DECISION_PATTERNS.map((pattern) => ({
  normalized: normalizeArabic(pattern.phrase),
  decision: pattern.decision,
}));

/**
 * Returns null for anything unrecognised rather than guessing. An unreadable
 * decision has to reach the head teacher as a row error in the preview — a
 * wrong guess here rewrites whether a real student passed.
 */
export function parseDecision(cellText: string): ImportedDecision | null {
  const normalized = normalizeArabic(cellText);
  if (normalized.length === 0) {
    return null;
  }
  // "لم يجتاز" negates "اجتاز", so a plain `includes` in the wrong order would
  // read a failure as a pass. The patterns are ordered longest-first and the
  // negative forms come before their positive prefixes.
  for (const pattern of NORMALIZED_DECISIONS) {
    if (normalized.includes(pattern.normalized)) {
      return pattern.decision;
    }
  }
  return null;
}

/**
 * §6.2: "split on `/` `،` `,` and leading `و`".
 *
 * The leading و is the Arabic conjunction «و» prefixed to a word (وفقه = "and
 * fiqh"), not a separator character, so it is stripped from each token after
 * splitting rather than being split on — splitting on و would cut through any
 * subject name containing the letter.
 */
const SEPARATORS = /[/،,؛;\n\r]+/;

export function splitSubjectList(cellText: string): string[] {
  if (cellText.trim().length === 0) {
    return [];
  }

  // Splits the RAW text and returns RAW tokens, for two separate reasons:
  //
  // 1. Splitting must happen before normalisation. normalizeArabic collapses
  //    all whitespace, so a multi-line cell (Alt+Enter, which these sheets do
  //    use) would otherwise arrive as one space-joined string and come back as
  //    a single bogus subject.
  // 2. The token is what an error message quotes back to the reviewer, who
  //    then has to find it in the spreadsheet. Quoting the normalised form
  //    ("ماده مجهوله") sends them looking for text that is not in their file.
  //
  // De-duplication still happens on the normalised key, because the same
  // subject listed twice on one sheet is a transcription artefact, not two
  // carries — carried_subjects is unique on (enrollment, subject).
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const piece of cellText.split(SEPARATORS)) {
    const token = stripLeadingConjunction(piece.trim());
    const key = normalizeArabic(token);
    if (key.length === 0 || !hasLetters(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tokens.push(token);
  }

  return tokens;
}

/**
 * A subject name always contains letters. A cell holding only punctuation is a
 * placeholder, not a subject.
 *
 * The export prints «—» in a carry column a student owes nothing to, so that an
 * empty cell cannot be mistaken for a column nobody filled in. Reading that
 * dash back as a token would resolve against no alias and turn a clean row into
 * an error row — the file this codebase writes has to be a file it can read.
 */
function hasLetters(normalized: string): boolean {
  return /\p{L}/u.test(normalized);
}

/**
 * Removes a leading «و» only when what follows is still a plausible word.
 * `وفقه` → `فقه`, but `ورد` is left alone: stripping it would leave `رد`, a
 * different word, and the row is better flagged for review than silently
 * changed.
 */
const MIN_LENGTH_AFTER_STRIPPING = 3;

function stripLeadingConjunction(token: string): string {
  if (!token.startsWith('و')) {
    return token;
  }
  const remainder = token.slice(1).trim();
  return remainder.length >= MIN_LENGTH_AFTER_STRIPPING ? remainder : token;
}

/**
 * §6.2: "resolve via `subject_aliases` … An unresolved token flags the row for
 * review — **never auto-create a subject**."
 */
export interface SubjectResolution {
  token: string;
  subjectId: number | null;
}

export function resolveSubjects(
  tokens: string[],
  aliasesByNormalized: Map<string, number>,
): SubjectResolution[] {
  return tokens.map((token) => ({
    token,
    // Tokens arrive already normalised from splitSubjectList; normalising
    // again is harmless and makes this safe to call with raw input too.
    subjectId: aliasesByNormalized.get(normalizeArabic(token)) ?? null,
  }));
}

/**
 * §6.2: header row 3 reads `2026 / 1447`. "Parse the Hijri part, don't trust
 * the filename." The Hijri year is the four-digit number in the 1300–1500
 * range; the Gregorian one is 1900–2200, so they cannot be confused.
 */
export function parseHijriYear(headerText: string): number | null {
  const digits = normalizeArabic(headerText).match(/\d{3,4}/g);
  if (!digits) {
    return null;
  }
  for (const candidate of digits) {
    const value = Number.parseInt(candidate, 10);
    if (value >= 1300 && value <= 1500) {
      return value;
    }
  }
  return null;
}
