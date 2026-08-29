import {
  CurriculumMarking,
  resolveOutcome,
  weightedTermTotal,
} from './scoring';

const SCORED: CurriculumMarking = {
  maxScore: 100,
  passScore: 50,
  gradingMode: 'score',
  weight: 1,
};
const RECITED: CurriculumMarking = { ...SCORED, gradingMode: 'pass_fail' };

describe('resolveOutcome — scored subjects (R18)', () => {
  // The pass mark is inclusive: `score >= curriculum.pass_score` (§4.2). One
  // mark either side of the threshold is the whole decision.
  it.each([
    [49, 'fail'],
    [50, 'pass'],
    [51, 'pass'],
    [0, 'fail'],
    [100, 'pass'],
  ])('a score of %i is %s against a pass mark of 50', (score, expected) => {
    expect(resolveOutcome({ score, isAbsent: false }, SCORED)).toBe(expected);
  });

  it('respects a pass mark the head teacher moved', () => {
    const strict = { ...SCORED, passScore: 60 };

    expect(resolveOutcome({ score: 55, isAbsent: false }, strict)).toBe('fail');
    expect(resolveOutcome({ score: 60, isAbsent: false }, strict)).toBe('pass');
  });
});

describe('resolveOutcome — absence', () => {
  // "Did not sit" and "failed" are different facts with different remedies;
  // scoring an absence as 0 would collapse them.
  it('reports absent rather than fail, whatever the score field holds', () => {
    expect(resolveOutcome({ score: null, isAbsent: true }, SCORED)).toBe(
      'absent',
    );
    expect(resolveOutcome({ score: 90, isAbsent: true }, SCORED)).toBe(
      'absent',
    );
  });

  it('outranks pass_fail mode too', () => {
    expect(
      resolveOutcome({ score: null, isAbsent: true, passed: true }, RECITED),
    ).toBe('absent');
  });
});

describe('resolveOutcome — pass_fail subjects', () => {
  it.each([
    [true, 'pass'],
    [false, 'fail'],
    [undefined, 'fail'],
  ])('passed=%s gives %s and ignores any score', (passed, expected) => {
    expect(
      resolveOutcome({ score: 12, isAbsent: false, passed }, RECITED),
    ).toBe(expected);
  });
});

describe('weightedTermTotal — §4.2 Σ(score × weight) / Σ(max × weight)', () => {
  it('weights each subject by its own weight', () => {
    const total = weightedTermTotal([
      { score: 80, isAbsent: false, marking: { ...SCORED, weight: 2 } },
      { score: 40, isAbsent: false, marking: { ...SCORED, weight: 1 } },
    ]);

    // (80×2 + 40×1) / (100×2 + 100×1) = 200/300
    expect(total.totalScore).toBe(200);
    expect(total.maxTotal).toBe(300);
    expect(total.percentage).toBeCloseTo(66.67, 2);
  });

  // A missed paper must still count against the denominator, or skipping an
  // exam would raise the student's percentage.
  it('counts an absence as zero without removing its weight', () => {
    const total = weightedTermTotal([
      { score: 100, isAbsent: false, marking: SCORED },
      { score: null, isAbsent: true, marking: SCORED },
    ]);

    expect(total.totalScore).toBe(100);
    expect(total.maxTotal).toBe(200);
    expect(total.percentage).toBe(50);
  });

  it('excludes pass_fail subjects from both sides of the ratio', () => {
    const total = weightedTermTotal([
      { score: 80, isAbsent: false, marking: SCORED },
      { score: null, isAbsent: false, marking: RECITED },
    ]);

    expect(total.maxTotal).toBe(100);
    expect(total.percentage).toBe(80);
  });

  it.each([
    ['no entries at all', []],
    [
      'only pass_fail entries',
      [{ score: null, isAbsent: false, marking: RECITED }],
    ],
  ])('reports no percentage for %s rather than zero', (_label, entries) => {
    const total = weightedTermTotal(entries);

    expect(total.maxTotal).toBe(0);
    expect(total.percentage).toBeNull();
  });

  it('honours a max score that is not 100', () => {
    const outOfFifty = { ...SCORED, maxScore: 50, passScore: 25 };
    const total = weightedTermTotal([
      { score: 25, isAbsent: false, marking: outOfFifty },
    ]);

    expect(total.percentage).toBe(50);
  });

  // The result lands in NUMERIC(6,2); binary-float noise must not reach it.
  it('rounds to two decimals so the value fits the column', () => {
    const total = weightedTermTotal([
      { score: 33.33, isAbsent: false, marking: { ...SCORED, weight: 3 } },
    ]);

    expect(total.totalScore).toBe(99.99);
    expect(Number.isInteger(total.percentage! * 100)).toBe(true);
  });
});
