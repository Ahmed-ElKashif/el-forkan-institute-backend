import {
  decideAfterMakeup,
  decidePromotion,
  FailedUnit,
  LevelRules,
  ProgressionRules,
  resolveProgressionRules,
} from './promotion';

const L1: LevelRules = { allowsCarry: true, isTerminal: false };
const L4: LevelRules = { allowsCarry: true, isTerminal: true };
const PREP: LevelRules = { allowsCarry: false, isTerminal: false };

// The v1.1 defaults from schema-v1.1.sql: carry limit 3 (R13), makeup round
// on, and an إلزامية failure cannot be carried (R17).
const DEFAULT_RULES: ProgressionRules = {
  maxCarriedSubjects: 3,
  makeupRoundEnabled: true,
  carryForwardEnabled: true,
  mandatoryCanBeCarried: false,
};

const optional = (n: number): FailedUnit[] =>
  Array.from({ length: n }, (_, i) => ({
    subjectId: i + 1,
    isMandatory: false,
  }));
const withMandatory = (n: number): FailedUnit[] => [
  { subjectId: 99, isMandatory: true },
  ...optional(n - 1),
];

describe('decidePromotion — clean pass', () => {
  it('promotes a student who failed nothing', () => {
    expect(decidePromotion([], L1, DEFAULT_RULES)).toBe('promote');
  });

  // R1: L4 is the qualification, so finishing it is graduation, not promotion
  // into a level that does not exist.
  it('graduates a clean terminal level rather than promoting', () => {
    expect(decidePromotion([], L4, DEFAULT_RULES)).toBe('graduate');
  });
});

describe('decidePromotion — PREP has no carry (R15)', () => {
  it.each([1, 2, 3, 5])(
    'makes a PREP student with %i failure(s) repeat the whole level',
    (count) => {
      expect(decidePromotion(optional(count), PREP, DEFAULT_RULES)).toBe(
        'repeat',
      );
    },
  );

  // The check must sit above the mandatory branch: a PREP student with a
  // failed إلزامية repeats, and is never sent to a makeup that cannot help.
  it('repeats rather than requiring a makeup when the failure is mandatory', () => {
    expect(decidePromotion(withMandatory(1), PREP, DEFAULT_RULES)).toBe(
      'repeat',
    );
  });
});

describe('decidePromotion — mandatory subjects block promotion (R17)', () => {
  it('requires a makeup for a failed إلزامية even within the carry limit', () => {
    expect(decidePromotion(withMandatory(1), L1, DEFAULT_RULES)).toBe(
      'makeup_required',
    );
  });

  // The v1.0 behaviour, kept configurable: two 1447 students did progress
  // carrying عقيدة (§4.3), so the flag has to be able to restore that.
  it('carries a failed إلزامية when the head teacher allows it', () => {
    expect(
      decidePromotion(withMandatory(1), L1, {
        ...DEFAULT_RULES,
        mandatoryCanBeCarried: true,
        makeupRoundEnabled: false,
      }),
    ).toBe('promote_with_carry');
  });
});

describe('decidePromotion — the carry limit (R13)', () => {
  // The evidence table in §4.3: the 1447 sheets separate perfectly at three.
  // 1/2/3 failures → إجتاز المستوى بمواد, 4+ → لم يجتاز المستوى.
  const NO_MAKEUP: ProgressionRules = {
    ...DEFAULT_RULES,
    makeupRoundEnabled: false,
  };

  it.each([
    [1, 'promote_with_carry'],
    [2, 'promote_with_carry'],
    [3, 'promote_with_carry'],
    [4, 'repeat'],
    [5, 'repeat'],
    [8, 'repeat'],
  ])('%i failed subjects → %s', (count, expected) => {
    expect(decidePromotion(optional(count), L1, NO_MAKEUP)).toBe(expected);
  });

  it('sends the same student to a makeup instead when the round is enabled', () => {
    expect(decidePromotion(optional(3), L1, DEFAULT_RULES)).toBe(
      'makeup_required',
    );
  });

  // Boundary: exactly at the limit carries, one over repeats.
  it.each([
    [0, 3, 'promote'],
    [3, 3, 'promote_with_carry'],
    [4, 3, 'repeat'],
    [1, 0, 'repeat'],
    [0, 0, 'promote'],
  ])(
    '%i failures against a limit of %i → %s',
    (count, maxCarriedSubjects, expected) => {
      expect(
        decidePromotion(optional(count), L1, {
          ...DEFAULT_RULES,
          makeupRoundEnabled: false,
          maxCarriedSubjects,
        }),
      ).toBe(expected);
    },
  );
});

describe('decideAfterMakeup', () => {
  it('promotes when the makeup cleared everything', () => {
    expect(decideAfterMakeup([], L1, DEFAULT_RULES)).toBe('promote');
  });

  // Deliberate departure (1) documented on decideAfterMakeup: the spec's
  // second snippet says 'promote', but graduation cannot depend on which
  // round the student passed in.
  it('graduates a terminal level cleared in the makeup round', () => {
    expect(decideAfterMakeup([], L4, DEFAULT_RULES)).toBe('graduate');
  });

  it('repeats when a mandatory subject is still failed (R17 bites here)', () => {
    expect(decideAfterMakeup(withMandatory(1), L1, DEFAULT_RULES)).toBe(
      'repeat',
    );
  });

  it('carries the remainder when it is within the limit', () => {
    expect(decideAfterMakeup(optional(2), L1, DEFAULT_RULES)).toBe(
      'promote_with_carry',
    );
  });

  it('repeats when carrying forward is switched off entirely', () => {
    expect(
      decideAfterMakeup(optional(1), L1, {
        ...DEFAULT_RULES,
        carryForwardEnabled: false,
      }),
    ).toBe('repeat');
  });

  it.each([
    [3, 'promote_with_carry'],
    [4, 'repeat'],
  ])('%i still-failed subjects → %s', (count, expected) => {
    expect(decideAfterMakeup(optional(count), L1, DEFAULT_RULES)).toBe(
      expected,
    );
  });

  // Deliberate departure (2): unreachable through decidePromotion today, but
  // R15 must hold if this function is ever called directly.
  it('never lets PREP carry, even here', () => {
    expect(decideAfterMakeup(optional(1), PREP, DEFAULT_RULES)).toBe('repeat');
  });
});

describe('resolveProgressionRules', () => {
  const yearFallback = { levelId: null, maxCarriedSubjects: 3 };
  const prepRule = { levelId: 1, maxCarriedSubjects: 0 };

  it("prefers the level's own row over the year fallback", () => {
    expect(resolveProgressionRules([yearFallback, prepRule], 1)).toBe(prepRule);
  });

  it('falls back to the year row for a level with no explicit rule', () => {
    expect(resolveProgressionRules([yearFallback, prepRule], 2)).toBe(
      yearFallback,
    );
  });

  // Returning defaults here would decide a real student's year on a guess.
  it('returns null when neither exists, so the caller must surface it', () => {
    expect(resolveProgressionRules([], 2)).toBeNull();
    expect(resolveProgressionRules([prepRule], 2)).toBeNull();
  });
});
