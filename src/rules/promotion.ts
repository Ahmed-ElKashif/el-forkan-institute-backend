/**
 * §4.3 — the promotion decision, both rounds.
 *
 * Transcribed from the spec's pseudocode rather than adapted from anything
 * else, because the two passes differ in ways that look like copy-paste
 * variants and are not: the first can send a student to a makeup round, the
 * second cannot, and R17 bites in a different place in each.
 */

export type PromotionDecision =
  'promote' | 'promote_with_carry' | 'repeat' | 'makeup_required' | 'graduate';

/** One failed leaf subject (R14: sub-subjects are counted individually). */
export interface FailedUnit {
  subjectId: number;
  isMandatory: boolean;
}

export interface LevelRules {
  /** PREP is FALSE: pass, or repeat the whole preparatory level (R15). */
  allowsCarry: boolean;
  /** L4 — completing it is graduation, not promotion. */
  isTerminal: boolean;
}

export interface ProgressionRules {
  maxCarriedSubjects: number;
  makeupRoundEnabled: boolean;
  carryForwardEnabled: boolean;
  /** Defaults to FALSE in v1.1: a مادة إلزامية blocks promotion (R17). */
  mandatoryCanBeCarried: boolean;
}

/**
 * The decision taken when the term's results are first complete.
 *
 * Order matters and is not arbitrary: the terminal/graduate case must come
 * before everything else so a clean L4 graduates rather than promotes; the
 * PREP no-carry case must come before the mandatory check so a PREP student
 * repeats rather than being sent to a makeup that cannot help them.
 */
export function decidePromotion(
  failed: FailedUnit[],
  level: LevelRules,
  rules: ProgressionRules,
): PromotionDecision {
  if (failed.length === 0) {
    return level.isTerminal ? 'graduate' : 'promote';
  }

  if (!level.allowsCarry) {
    return 'repeat'; // R15 — repeats the whole level
  }

  const failedMandatory = failed.filter((unit) => unit.isMandatory);
  if (failedMandatory.length > 0 && !rules.mandatoryCanBeCarried) {
    return 'makeup_required'; // R17 — must be cleared, never carried
  }

  if (failed.length <= rules.maxCarriedSubjects) {
    return rules.makeupRoundEnabled ? 'makeup_required' : 'promote_with_carry';
  }

  return 'repeat';
}

/**
 * The decision after the makeup round has been sat.
 *
 * `stillFailed` is the subset of the original failures not cleared in the
 * makeup. This pass has no `makeup_required` outcome — there is no second
 * makeup — and R17 produces `repeat` here rather than another makeup.
 *
 * TWO DELIBERATE DEPARTURES from the §4.3 post-makeup pseudocode, both flagged
 * rather than made silently:
 *
 * 1. **Terminal levels graduate, they do not promote.** The spec's second
 *    snippet says `decision = 'promote'` for an empty `still_failed`, while
 *    its first snippet distinguishes `graduate` from `promote` by
 *    `level.is_terminal`. Read literally, a student who cleared L4 in the
 *    makeup round would be "promoted" out of the final level, to nothing.
 *    **Confirmed by the head teacher (2026-08-25):** COMP is elective and no
 *    student is obliged to take it, so completing L4 IS graduation — a
 *    student graduates whether or not they go on to COMP, and regardless of
 *    which round they cleared L4 in.
 *
 * 2. **PREP still cannot carry.** The second snippet omits the
 *    `allows_carry` check that guards the first. In the current flow that is
 *    harmless, because `decidePromotion` never routes a PREP enrolment to a
 *    makeup — it returns `repeat` directly (R15). The guard is kept anyway:
 *    this function is callable independently, and without it a PREP student
 *    reaching it would receive `promote_with_carry`, which R15 forbids
 *    outright.
 */
export function decideAfterMakeup(
  stillFailed: FailedUnit[],
  level: LevelRules,
  rules: ProgressionRules,
): PromotionDecision {
  if (stillFailed.length === 0) {
    return level.isTerminal ? 'graduate' : 'promote';
  }

  if (!level.allowsCarry) {
    return 'repeat'; // R15 — see departure (2) above
  }

  const blocksPromotion =
    stillFailed.some((unit) => unit.isMandatory) &&
    !rules.mandatoryCanBeCarried;
  if (blocksPromotion) {
    return 'repeat'; // R17 bites here
  }

  if (
    stillFailed.length <= rules.maxCarriedSubjects &&
    rules.carryForwardEnabled
  ) {
    return 'promote_with_carry';
  }

  return 'repeat';
}

/**
 * §4.3: rules come from the level's own `progression_rules` row, falling back
 * to the year's `level_id IS NULL` row. Returns null when neither exists,
 * which is a configuration error the caller must surface rather than paper
 * over with defaults — silently assuming a carry limit would decide a real
 * student's year on a guess.
 */
export function resolveProgressionRules<T extends { levelId: number | null }>(
  candidates: T[],
  levelId: number,
): T | null {
  return (
    candidates.find((rule) => rule.levelId === levelId) ??
    candidates.find((rule) => rule.levelId === null) ??
    null
  );
}
