import { AbsencePolicy, assessAbsences } from './absence';

// The DDL's seeded defaults: warn at 3, block at 4.
const WARN_ONLY: AbsencePolicy = {
  maxAbsences: 4,
  warnAtAbsences: 3,
  autoWarnEnabled: true,
  exceedingAction: 'warn_only',
};
const BLOCKING: AbsencePolicy = { ...WARN_ONLY, exceedingAction: 'block_exam' };

describe('assessAbsences — which threshold was crossed', () => {
  it.each([
    [0, null],
    [2, null],
    [3, 3],
    [4, 4],
    [7, 4],
  ])('%i absences warns at threshold %s', (count, expected) => {
    expect(assessAbsences(count, WARN_ONLY).warningThreshold).toBe(expected);
  });

  // A bulk attendance save can move a student from 2 to 4 in one write. One
  // serious warning is the right message; two warnings at once is spam, and
  // §4.8's uniqueness constraint exists precisely to prevent that shape.
  it('reports only the highest threshold reached, not every one crossed', () => {
    expect(assessAbsences(5, WARN_ONLY).warningThreshold).toBe(4);
  });

  it('stays silent when automatic warnings are switched off', () => {
    expect(
      assessAbsences(9, { ...WARN_ONLY, autoWarnEnabled: false })
        .warningThreshold,
    ).toBeNull();
  });
});

describe('assessAbsences — exam blocking (§4.6 low_attendance)', () => {
  it.each([
    [3, false],
    [4, true],
    [10, true],
  ])('%i absences under block_exam blocks=%s', (count, expected) => {
    expect(assessAbsences(count, BLOCKING).blocksExams).toBe(expected);
  });

  it('never blocks under warn_only, however high the count', () => {
    expect(assessAbsences(50, WARN_ONLY).blocksExams).toBe(false);
  });

  // Turning warnings off must not quietly turn blocking off too: they are
  // separate switches in attendance_policies.
  it('still blocks when warnings are disabled', () => {
    expect(
      assessAbsences(4, { ...BLOCKING, autoWarnEnabled: false }).blocksExams,
    ).toBe(true);
  });
});
