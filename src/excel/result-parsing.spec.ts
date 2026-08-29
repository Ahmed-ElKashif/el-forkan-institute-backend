import {
  parseDecision,
  parseHijriYear,
  resolveSubjects,
  splitSubjectList,
} from './result-parsing';

describe('parseDecision', () => {
  it.each([
    ['a clean pass', 'إجتاز المستوى', 'promote'],
    ['a pass carrying subjects', 'إجتاز المستوى بمواد', 'promote_with_carry'],
    ['a failure', 'لم يجتاز المستوى', 'repeat'],
    ['the bare PREP pass', 'إجتاز', 'promote'],
  ])('reads %s', (_label, text, expected) => {
    expect(parseDecision(text)).toBe(expected);
  });

  // The decision column is padded with tatweel to justify the printed cell.
  it.each([
    ['إجـــتـــاز المستوى', 'promote'],
    ['لم يجـ__تـاز المستوى'.replace(/_/g, 'ـ'), 'repeat'],
    ['إجــتــاز الــمســتــوى بــمــواد', 'promote_with_carry'],
  ])('sees through tatweel padding in %s', (text, expected) => {
    expect(parseDecision(text)).toBe(expected);
  });

  it('tolerates spelling variants and extra whitespace', () => {
    expect(parseDecision('  اجتاز  المستوى  ')).toBe('promote');
  });

  // The bug this ordering exists to prevent: "لم يجتاز" CONTAINS "اجتاز", and
  // "إجتاز المستوى بمواد" contains "إجتاز المستوى".
  it('does not read a failure as a pass', () => {
    expect(parseDecision('لم يجتاز المستوى')).toBe('repeat');
  });

  it('does not read a carry as a clean pass', () => {
    expect(parseDecision('إجتاز المستوى بمواد')).toBe('promote_with_carry');
  });

  // Guessing here would rewrite whether a real student passed.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['an unrelated note', 'منقول من فرع آخر'],
    ['a number', '95'],
  ])('returns null for %s rather than guessing', (_label, text) => {
    expect(parseDecision(text)).toBeNull();
  });
});

describe('splitSubjectList', () => {
  it.each([
    ['slashes', 'نحو / بلاغة / فقه'],
    ['Arabic commas', 'نحو، بلاغة، فقه'],
    ['Latin commas', 'نحو, بلاغة, فقه'],
    ['newlines', 'نحو\nبلاغة\nفقه'],
  ])('splits on %s', (_label, text) => {
    expect(splitSubjectList(text)).toEqual(['نحو', 'بلاغة', 'فقه']);
  });

  // §6.2: "and leading و". It is a prefix conjunction, not a separator.
  it('strips the leading conjunction from a token', () => {
    expect(splitSubjectList('نحو، وبلاغة')).toEqual(['نحو', 'بلاغة']);
  });

  // Splitting on the letter و would cut through any subject containing it.
  it('does not split inside a word containing و', () => {
    expect(splitSubjectList('علوم القرآن')).toEqual(['علوم القرآن']);
  });

  it('leaves a short word alone rather than mangling it into another word', () => {
    // Stripping و from ورد leaves رد, a different word — flag, do not guess.
    expect(splitSubjectList('ورد')).toEqual(['ورد']);
  });

  it('collapses a subject listed twice on the same sheet', () => {
    expect(splitSubjectList('نحو / نحو')).toEqual(['نحو']);
  });

  // De-duplication is on the normalised key, but the token kept is the one as
  // written — the reviewer has to be able to find it in their file.
  it('treats the two spellings of سيرة as one subject', () => {
    expect(splitSubjectList('سيرة / سيره')).toEqual(['سيرة']);
  });

  it('returns tokens exactly as the teacher typed them', () => {
    expect(splitSubjectList('مادة مجهولة')).toEqual(['مادة مجهولة']);
  });

  it.each([
    ['empty', ''],
    ['only separators', '/ ، ,'],
    ['whitespace', '   '],
  ])('returns nothing for %s', (_label, text) => {
    expect(splitSubjectList(text)).toEqual([]);
  });
});

describe('resolveSubjects', () => {
  const aliases = new Map([
    ['نحو', 8],
    ['سيره', 11],
  ]);

  it('resolves a known alias to its subject id', () => {
    expect(resolveSubjects(['نحو'], aliases)).toEqual([
      { token: 'نحو', subjectId: 8 },
    ]);
  });

  it('resolves both spellings of سيرة through the normalised key', () => {
    expect(resolveSubjects(['سيرة'], aliases)[0].subjectId).toBe(11);
  });

  // §6.2: "An unresolved token flags the row for review — never auto-create
  // a subject."
  it('reports an unknown token as unresolved instead of inventing a subject', () => {
    expect(resolveSubjects(['مادة مجهولة'], aliases)).toEqual([
      { token: 'مادة مجهولة', subjectId: null },
    ]);
  });

  it('keeps the original token alongside the result so the error names it', () => {
    const [resolution] = resolveSubjects(['مجهول'], aliases);

    expect(resolution.token).toBe('مجهول');
    expect(resolution.subjectId).toBeNull();
  });
});

// §6.2: "Header row 3 `2026 / 1447` → parse the Hijri part, don't trust the
// filename."
describe('parseHijriYear', () => {
  it.each([
    ['2026 / 1447', 1447],
    ['1447 / 2026', 1447],
    ['العام الدراسى 2026 / 1447', 1447],
    ['١٤٤٧', 1447],
  ])('reads %s as %i', (text, expected) => {
    expect(parseHijriYear(text)).toBe(expected);
  });

  it('picks the Hijri year, never the Gregorian one', () => {
    expect(parseHijriYear('2026 / 1447')).not.toBe(2026);
  });

  it.each([
    ['no year at all', 'فرع أسوان'],
    ['only a Gregorian year', '2026'],
    ['empty', ''],
  ])('returns null for %s', (_label, text) => {
    expect(parseHijriYear(text)).toBeNull();
  });
});
