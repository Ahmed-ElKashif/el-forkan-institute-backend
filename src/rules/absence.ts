/**
 * §4.8 — the absence thresholds.
 *
 * `attendance_warnings` is UNIQUE on `(enrollment, term, threshold)`, so this
 * decides *which* threshold a count has newly crossed; the uniqueness
 * constraint is what makes re-runs unable to spam a student.
 */

export interface AbsencePolicy {
  maxAbsences: number;
  warnAtAbsences: number;
  autoWarnEnabled: boolean;
  exceedingAction: 'warn_only' | 'block_exam';
}

export interface AbsenceAssessment {
  /** The threshold to record a warning against, or null for none. Callers
   * insert it and let the unique constraint reject a repeat. */
  warningThreshold: number | null;
  /** True when the count has reached max AND the policy blocks exams: the
   * caller sets is_eligible=false with reason_code='low_attendance'. */
  blocksExams: boolean;
}

/**
 * The maximum threshold reached, not every threshold crossed: a student who
 * jumps from 2 to 4 absences (a bulk attendance save covering several
 * sessions) should get the serious warning, not two warnings at once.
 */
export function assessAbsences(
  absenceCount: number,
  policy: AbsencePolicy,
): AbsenceAssessment {
  const reachedMax = absenceCount >= policy.maxAbsences;
  const reachedWarn = absenceCount >= policy.warnAtAbsences;

  let warningThreshold: number | null = null;
  if (policy.autoWarnEnabled) {
    if (reachedMax) {
      warningThreshold = policy.maxAbsences;
    } else if (reachedWarn) {
      warningThreshold = policy.warnAtAbsences;
    }
  }

  return {
    warningThreshold,
    blocksExams: reachedMax && policy.exceedingAction === 'block_exam',
  };
}
