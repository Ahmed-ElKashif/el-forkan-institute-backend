/**
 * §4.6 / R7 — who is entitled to sit which exam (مستحقو الامتحانات).
 *
 * The predicate and the reason code are separated from the database query
 * deliberately: `exam_eligibility` is materialised and overridable, so the
 * head teacher can see *why* the engine decided what it did, and a wrong
 * reason code is as misleading as a wrong verdict.
 */

export type EligibilityReason =
  | 'new'
  | 'skipped_prep'
  | 'repeater'
  | 'carrying_subjects'
  | 'clearing_for_comp'
  | 'low_attendance'
  | 'already_passed'
  | 'not_in_scope';

export type EntryType =
  | 'new'
  | 'promoted'
  | 'promoted_with_carry'
  | 'repeater'
  | 'skipped_prep'
  | 'transfer';

export interface EnrollmentFacts {
  status: 'active' | 'completed' | 'withdrawn';
  entryType: EntryType;
  levelId: number;
  branchId: number;
  gender: 'male' | 'female';
  termAbsences: number;
  /** True when this student already holds a pass for the exam's subject —
   * from any prior enrolment, at any level. */
  alreadyPassedSubject: boolean;
  /** True when a `carried_subjects` row for the exam's subject is pending. */
  isCarryingExamSubject: boolean;
  /** True when the student is clearing carries specifically to enter COMP
   * (§4.4): their L4 is done but carries remain. */
  isClearingForComp: boolean;
}

export interface ExamFacts {
  levelId: number;
  branchId: number;
  /** Null means a shared sitting for both genders. */
  gender: 'male' | 'female' | null;
  isExaminable: boolean;
}

export interface AbsencePolicyFacts {
  maxAbsences: number;
  exceedingAction: 'warn_only' | 'block_exam';
}

export interface EligibilityVerdict {
  isEligible: boolean;
  reasonCode: EligibilityReason;
}

/**
 * ```
 * eligible(enrollment, exam) =
 *       enrollment.status  = 'active'
 *   AND section.level      = curriculum.level
 *   AND section.branch     = exam.branch
 *   AND student.gender     = exam.gender      (when exam.gender is set)
 *   AND curriculum.is_examinable
 *   AND NOT already_passed(student, curriculum.subject)
 *   AND (policy.exceeding_action <> 'block_exam' OR absences < policy.max_absences)
 * ```
 *
 * Plus carries: "a student carrying النحو from L2 while sitting in L3 is
 * eligible for the L2 النحو makeup." So the level match is not a plain
 * equality — a carried subject makes an exam at a *lower* level relevant, and
 * the caller signals that with `isCarryingExamSubject`.
 */
export function checkEligibility(
  enrollment: EnrollmentFacts,
  exam: ExamFacts,
  policy: AbsencePolicyFacts,
): EligibilityVerdict {
  if (enrollment.status !== 'active') {
    return { isEligible: false, reasonCode: 'not_in_scope' };
  }
  if (!exam.isExaminable) {
    // A grouping parent holds no exam of its own (§4.1).
    return { isEligible: false, reasonCode: 'not_in_scope' };
  }
  if (enrollment.branchId !== exam.branchId) {
    return { isEligible: false, reasonCode: 'not_in_scope' };
  }
  // R3: a shared sitting (exam.gender null) is open to both; a gendered exam
  // admits only that gender.
  if (exam.gender !== null && exam.gender !== enrollment.gender) {
    return { isEligible: false, reasonCode: 'not_in_scope' };
  }

  // Level match, or a carry that reaches back to an earlier level.
  const levelApplies =
    enrollment.levelId === exam.levelId || enrollment.isCarryingExamSubject;
  if (!levelApplies) {
    return { isEligible: false, reasonCode: 'not_in_scope' };
  }

  // Checked after scope but before attendance: a student who already holds
  // the pass should be told that, not told they are short on attendance for a
  // paper they never needed to sit.
  if (enrollment.alreadyPassedSubject && !enrollment.isCarryingExamSubject) {
    return { isEligible: false, reasonCode: 'already_passed' };
  }

  if (
    policy.exceedingAction === 'block_exam' &&
    enrollment.termAbsences >= policy.maxAbsences
  ) {
    return { isEligible: false, reasonCode: 'low_attendance' };
  }

  return { isEligible: true, reasonCode: entitlementReason(enrollment) };
}

/**
 * Why an eligible student is on the list. Drives the filtered views the head
 * teacher works from (§4.6), so the order is by specificity: the most
 * actionable label wins.
 */
function entitlementReason(enrollment: EnrollmentFacts): EligibilityReason {
  if (enrollment.isClearingForComp) {
    return 'clearing_for_comp';
  }
  if (enrollment.isCarryingExamSubject) {
    return 'carrying_subjects';
  }
  if (enrollment.entryType === 'repeater') {
    return 'repeater';
  }
  if (enrollment.entryType === 'skipped_prep') {
    return 'skipped_prep';
  }
  return 'new';
}
