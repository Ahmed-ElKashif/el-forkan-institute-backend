import {
  AbsencePolicyFacts,
  checkEligibility,
  EnrollmentFacts,
  ExamFacts,
} from './eligibility';

const ASWAN = 1;
const L2 = 2;
const L3 = 3;

const ENROLLED_IN_L3: EnrollmentFacts = {
  status: 'active',
  entryType: 'promoted',
  levelId: L3,
  branchId: ASWAN,
  gender: 'male',
  termAbsences: 0,
  alreadyPassedSubject: false,
  isCarryingExamSubject: false,
  isClearingForComp: false,
};

const L3_EXAM: ExamFacts = {
  levelId: L3,
  branchId: ASWAN,
  gender: null,
  isExaminable: true,
};

const WARN_ONLY: AbsencePolicyFacts = {
  maxAbsences: 4,
  exceedingAction: 'warn_only',
};
const BLOCKING: AbsencePolicyFacts = {
  maxAbsences: 4,
  exceedingAction: 'block_exam',
};

describe('checkEligibility — scope', () => {
  it('admits an active student sitting their own level', () => {
    expect(checkEligibility(ENROLLED_IN_L3, L3_EXAM, WARN_ONLY)).toEqual({
      isEligible: true,
      reasonCode: 'new',
    });
  });

  it.each([['completed'], ['withdrawn']] as const)(
    'excludes a %s enrolment',
    (status) => {
      expect(
        checkEligibility({ ...ENROLLED_IN_L3, status }, L3_EXAM, WARN_ONLY)
          .isEligible,
      ).toBe(false);
    },
  );

  it('excludes an exam in another branch', () => {
    expect(
      checkEligibility(ENROLLED_IN_L3, { ...L3_EXAM, branchId: 2 }, WARN_ONLY)
        .isEligible,
    ).toBe(false);
  });

  it('excludes a grouping parent, which holds no exam of its own', () => {
    expect(
      checkEligibility(
        ENROLLED_IN_L3,
        { ...L3_EXAM, isExaminable: false },
        WARN_ONLY,
      ).isEligible,
    ).toBe(false);
  });

  it('excludes a student sitting a different level with no carry', () => {
    expect(
      checkEligibility(ENROLLED_IN_L3, { ...L3_EXAM, levelId: L2 }, WARN_ONLY)
        .isEligible,
    ).toBe(false);
  });
});

// R3 is enforced structurally in the database for rosters; for a *sitting*,
// the exam's own gender is what decides.
describe('checkEligibility — gender segregation (R3)', () => {
  it('admits both genders to a shared sitting', () => {
    for (const gender of ['male', 'female'] as const) {
      expect(
        checkEligibility(
          { ...ENROLLED_IN_L3, gender },
          { ...L3_EXAM, gender: null },
          WARN_ONLY,
        ).isEligible,
      ).toBe(true);
    }
  });

  it('admits only the matching gender to a gendered sitting', () => {
    expect(
      checkEligibility(
        { ...ENROLLED_IN_L3, gender: 'male' },
        { ...L3_EXAM, gender: 'male' },
        WARN_ONLY,
      ).isEligible,
    ).toBe(true);
    expect(
      checkEligibility(
        { ...ENROLLED_IN_L3, gender: 'female' },
        { ...L3_EXAM, gender: 'male' },
        WARN_ONLY,
      ).isEligible,
    ).toBe(false);
  });
});

describe('checkEligibility — carried subjects reach back a level (§4.6)', () => {
  // The L3 أخوات sheet has a «مواد من المستوى الثانى» column, which is the
  // evidence that carries survive more than one promotion.
  it('admits an L3 student to an L2 makeup for the subject they carry', () => {
    const verdict = checkEligibility(
      { ...ENROLLED_IN_L3, isCarryingExamSubject: true },
      { ...L3_EXAM, levelId: L2 },
      WARN_ONLY,
    );

    expect(verdict).toEqual({
      isEligible: true,
      reasonCode: 'carrying_subjects',
    });
  });

  it('still admits a carried subject the student once passed elsewhere', () => {
    // A pending carry means the pass is not held for THIS level's requirement,
    // so already_passed must not veto the makeup they were told to sit.
    expect(
      checkEligibility(
        {
          ...ENROLLED_IN_L3,
          isCarryingExamSubject: true,
          alreadyPassedSubject: true,
        },
        { ...L3_EXAM, levelId: L2 },
        WARN_ONLY,
      ).isEligible,
    ).toBe(true);
  });
});

describe('checkEligibility — already passed', () => {
  it('excludes a student who already holds the pass', () => {
    expect(
      checkEligibility(
        { ...ENROLLED_IN_L3, alreadyPassedSubject: true },
        L3_EXAM,
        WARN_ONLY,
      ),
    ).toEqual({ isEligible: false, reasonCode: 'already_passed' });
  });

  // Ordering matters: telling a student they are short on attendance for a
  // paper they never needed to sit sends them to the wrong remedy.
  it('reports already_passed rather than low_attendance when both apply', () => {
    expect(
      checkEligibility(
        { ...ENROLLED_IN_L3, alreadyPassedSubject: true, termAbsences: 9 },
        L3_EXAM,
        BLOCKING,
      ).reasonCode,
    ).toBe('already_passed');
  });
});

describe('checkEligibility — absence policy (§4.8)', () => {
  it.each([
    [3, true],
    [4, false],
    [5, false],
  ])(
    '%i absences against a max of 4 with block_exam → eligible=%s',
    (termAbsences, expected) => {
      expect(
        checkEligibility({ ...ENROLLED_IN_L3, termAbsences }, L3_EXAM, BLOCKING)
          .isEligible,
      ).toBe(expected);
    },
  );

  it('never blocks under a warn_only policy, however many absences', () => {
    expect(
      checkEligibility(
        { ...ENROLLED_IN_L3, termAbsences: 20 },
        L3_EXAM,
        WARN_ONLY,
      ).isEligible,
    ).toBe(true);
  });

  it('labels the block low_attendance so the override list is filterable', () => {
    expect(
      checkEligibility(
        { ...ENROLLED_IN_L3, termAbsences: 4 },
        L3_EXAM,
        BLOCKING,
      ).reasonCode,
    ).toBe('low_attendance');
  });
});

describe('checkEligibility — reason codes drive the filtered lists (R7)', () => {
  it.each([
    ['new', { entryType: 'new' as const }, 'new'],
    ['a repeater', { entryType: 'repeater' as const }, 'repeater'],
    ['a prep-skipper', { entryType: 'skipped_prep' as const }, 'skipped_prep'],
    ['a carrier', { isCarryingExamSubject: true }, 'carrying_subjects'],
    [
      'someone clearing for COMP',
      { isClearingForComp: true },
      'clearing_for_comp',
    ],
  ])('labels %s as %s', (_label, overrides, expected) => {
    expect(
      checkEligibility({ ...ENROLLED_IN_L3, ...overrides }, L3_EXAM, WARN_ONLY)
        .reasonCode,
    ).toBe(expected);
  });

  // Most actionable label wins: the head teacher needs the COMP list to be
  // complete, and a COMP-clearer is also, technically, a carrier.
  it('prefers clearing_for_comp over carrying_subjects when both are true', () => {
    expect(
      checkEligibility(
        {
          ...ENROLLED_IN_L3,
          isCarryingExamSubject: true,
          isClearingForComp: true,
        },
        L3_EXAM,
        WARN_ONLY,
      ).reasonCode,
    ).toBe('clearing_for_comp');
  });
});
