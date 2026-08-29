/**
 * §4.4 / R20 — the COMP entry gate.
 *
 * A gate on *enrolment*, not an automatic promotion: COMP is elective and
 * student-chosen, so nothing here ever enrols anyone. It only answers whether
 * an enrolment the head teacher is attempting is allowed.
 */

import type { PromotionDecision } from './promotion';

/**
 * What enrollments.final_decision can actually hold. Wider than
 * PromotionDecision: 'withdrawn' is never produced by the promotion engine,
 * but the column can carry it, and this gate reads a *stored* decision.
 */
export type StoredDecision = PromotionDecision | 'withdrawn';

export interface CompEntryInput {
  /** The student's most recent L4 enrolment, or null if they never sat L4. */
  latestL4Decision: StoredDecision | null;
  /** `carried_subjects` rows still at status 'pending', across ALL prior
   * enrolments — carries survive more than one promotion (§4.6). */
  pendingCarryCount: number;
}

export type CompEntryRefusal =
  'no_l4_enrollment' | 'l4_not_completed' | 'pending_carries';

export interface CompEntryVerdict {
  allowed: boolean;
  refusal: CompEntryRefusal | null;
}

/**
 * ```
 * return (l4 and l4.final_decision in ('promote', 'graduate')
 *         and count_pending_carries(student) == 0)
 * ```
 * Returns a reason rather than a bare boolean: the head teacher needs to know
 * *which* condition failed, because "sit these three makeup papers" and "you
 * have not finished L4" are different instructions to give a student.
 */
export function checkCompEntry(input: CompEntryInput): CompEntryVerdict {
  if (input.latestL4Decision === null) {
    return { allowed: false, refusal: 'no_l4_enrollment' };
  }

  const completedL4 =
    input.latestL4Decision === 'promote' ||
    input.latestL4Decision === 'graduate';
  if (!completedL4) {
    // `promote_with_carry` lands here: the student finished L4 but not
    // cleanly, and R20 requires a clean L4.
    return { allowed: false, refusal: 'l4_not_completed' };
  }

  if (input.pendingCarryCount > 0) {
    return { allowed: false, refusal: 'pending_carries' };
  }

  return { allowed: true, refusal: null };
}
