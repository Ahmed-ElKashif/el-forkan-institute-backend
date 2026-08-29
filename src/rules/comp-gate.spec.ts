import { checkCompEntry } from './comp-gate';

describe('checkCompEntry — R20 requires a clean L4', () => {
  it.each([['promote'], ['graduate']] as const)(
    'admits a student whose L4 ended in %s with no pending carries',
    (latestL4Decision) => {
      expect(
        checkCompEntry({ latestL4Decision, pendingCarryCount: 0 }),
      ).toEqual({ allowed: true, refusal: null });
    },
  );

  it('refuses a student who never enrolled in L4', () => {
    expect(
      checkCompEntry({ latestL4Decision: null, pendingCarryCount: 0 }),
    ).toEqual({ allowed: false, refusal: 'no_l4_enrollment' });
  });

  // The case R20 exists for: finishing L4 is not the same as finishing it
  // cleanly.
  it('refuses a student who passed L4 carrying subjects', () => {
    expect(
      checkCompEntry({
        latestL4Decision: 'promote_with_carry',
        pendingCarryCount: 2,
      }),
    ).toEqual({ allowed: false, refusal: 'l4_not_completed' });
  });

  // 'withdrawn' is never produced by the promotion engine but the column can
  // hold it, so the gate has to answer for it too.
  it.each([['repeat'], ['makeup_required'], ['withdrawn']] as const)(
    'refuses a student whose L4 ended in %s',
    (latestL4Decision) => {
      expect(
        checkCompEntry({ latestL4Decision, pendingCarryCount: 0 }).allowed,
      ).toBe(false);
    },
  );

  // Carries survive more than one promotion (§4.6), so a clean-looking L4 can
  // still sit behind an unfinished subject from L2.
  it('refuses a clean L4 that still has a carry pending from an earlier level', () => {
    expect(
      checkCompEntry({ latestL4Decision: 'promote', pendingCarryCount: 1 }),
    ).toEqual({ allowed: false, refusal: 'pending_carries' });
  });

  it('admits once the last carry is cleared', () => {
    expect(
      checkCompEntry({ latestL4Decision: 'graduate', pendingCarryCount: 0 })
        .allowed,
    ).toBe(true);
  });
});
