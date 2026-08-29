/**
 * §4.2 — turning a mark into a result, and marks into a term total.
 *
 * Pure: no database, no Nest, no clock. The whole rules engine is written this
 * way because these are the calculations that decide whether a real student
 * progresses, and they need to be testable exhaustively without a running
 * application.
 */

export type ExamOutcome = 'pass' | 'fail' | 'absent';

export interface CurriculumMarking {
  /** §4.2: exams inherit both from their curriculum row, so an exam's pass
   * mark can never drift from the syllabus's. */
  maxScore: number;
  passScore: number;
  /** 'pass_fail' is for subjects assessed by recitation, where a mark is
   * meaningless; 'score' is the default (R18). */
  gradingMode: 'score' | 'pass_fail';
  weight: number;
}

export interface ScoredResult {
  isAbsent: boolean;
  /** Null when absent, or when gradingMode is 'pass_fail'. */
  score: number | null;
  /** Only consulted in 'pass_fail' mode. */
  passed?: boolean;
}

/**
 * ```
 * result = 'absent'  if is_absent
 *        = 'pass'    if score >= curriculum.pass_score
 *        = 'fail'    otherwise
 * ```
 * Absence outranks everything: an absent student has no mark to compare, and
 * treating a missing score as 0 would silently convert "did not sit" into
 * "failed", which are different facts with different remedies.
 */
export function resolveOutcome(
  result: ScoredResult,
  marking: CurriculumMarking,
): ExamOutcome {
  if (result.isAbsent) {
    return 'absent';
  }
  if (marking.gradingMode === 'pass_fail') {
    return result.passed ? 'pass' : 'fail';
  }
  if (result.score === null) {
    // A scored subject with no mark recorded is not yet decided; callers hold
    // these as 'pending' in the database and must not read them as failures.
    return 'fail';
  }
  return result.score >= marking.passScore ? 'pass' : 'fail';
}

export interface WeightedEntry {
  score: number | null;
  isAbsent: boolean;
  marking: CurriculumMarking;
}

export interface TermTotal {
  totalScore: number;
  maxTotal: number;
  /** Null when nothing counted towards the total, rather than 0 — a student
   * with no marks yet has no percentage, and 0 would read as total failure. */
  percentage: number | null;
}

/**
 * §4.2: `Σ(score × weight) / Σ(max_score × weight)`.
 *
 * An absence contributes 0 to the numerator but still contributes its weight
 * to the denominator: a missed exam has to count against the total, otherwise
 * skipping a paper would raise a student's percentage.
 *
 * `pass_fail` rows are excluded from both sides. They have no meaningful
 * mark, so folding them in would require inventing one.
 */
export function weightedTermTotal(entries: WeightedEntry[]): TermTotal {
  let totalScore = 0;
  let maxTotal = 0;

  for (const entry of entries) {
    if (entry.marking.gradingMode === 'pass_fail') {
      continue;
    }
    maxTotal += entry.marking.maxScore * entry.marking.weight;
    if (!entry.isAbsent && entry.score !== null) {
      totalScore += entry.score * entry.marking.weight;
    }
  }

  return {
    totalScore: round2(totalScore),
    maxTotal: round2(maxTotal),
    percentage: maxTotal === 0 ? null : round2((totalScore / maxTotal) * 100),
  };
}

// Scores are NUMERIC(6,2) in the database; rounding here keeps the computed
// total from carrying binary-float noise into a column that cannot hold it.
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
