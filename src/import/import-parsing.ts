import { normalizeArabic } from '../common/arabic';
import {
  parseDecision,
  resolveSubjects,
  splitSubjectList,
} from '../excel/result-parsing';
import type { DataRow } from '../excel/sheet-reader';

/**
 * Turns one worksheet row into a decision about what the commit should do —
 * pure, so the §6.3 preview can be tested against the real sheet shapes
 * without a database.
 *
 * §6.3 exists because "the real data has an L3 أخوات sheet with 18 outcome
 * rows and no names, two different files both called `كشف_أسماء.xlsx`, and the
 * same level named both `المستوى الثالث` and `الفرقة الثالثة`. Fire-and-forget
 * would corrupt the database on the first run."
 */

export type RowAction = 'create' | 'update' | 'skip' | 'error';

export interface ExistingStudent {
  id: string;
  /** `normalizeArabic(full_name)` — precomputed by the caller so matching a
   * whole sheet stays a map lookup per row rather than a re-normalisation. */
  normalizedName: string;
  hasPhone: boolean;
  hasMarkaz: boolean;
}

export interface RosterRowParse {
  action: RowAction;
  error: string | null;
  matchStudentId: string | null;
  parsed: {
    fullName: string;
    normalizedName: string;
    rawPhone: string;
    rawMarkaz: string;
  };
}

/**
 * §6.2: "`الأسم` → students.full_name (required — reject row if empty)".
 * Everything else on a roster sheet is optional, because the institute's
 * existing rosters are names-only.
 */
export function parseRosterRow(
  row: DataRow,
  studentsByNormalizedName: Map<string, ExistingStudent>,
): RosterRowParse {
  const fullName = (row.values.name ?? '').trim();
  const normalizedName = normalizeArabic(fullName);
  const parsed = {
    fullName,
    normalizedName,
    rawPhone: (row.values.phone ?? '').trim(),
    rawMarkaz: (row.values.markaz ?? '').trim(),
  };

  if (normalizedName.length === 0) {
    return {
      action: 'error',
      error: 'Row has no name',
      matchStudentId: null,
      parsed,
    };
  }

  const existing = studentsByNormalizedName.get(normalizedName);
  if (!existing) {
    return { action: 'create', error: null, matchStudentId: null, parsed };
  }

  // §6.4: "Then teachers fill phone and markaz manually." An import that
  // brings a phone for a student who has none is an update worth making; one
  // that brings nothing new is a skip, so the preview shows the reviewer only
  // the rows that change something.
  const addsPhone = parsed.rawPhone.length > 0 && !existing.hasPhone;
  const addsMarkaz = parsed.rawMarkaz.length > 0 && !existing.hasMarkaz;
  return {
    action: addsPhone || addsMarkaz ? 'update' : 'skip',
    error: null,
    matchStudentId: existing.id,
    parsed,
  };
}

export interface ResultRowParse {
  action: RowAction;
  error: string | null;
  matchStudentId: string | null;
  parsed: {
    fullName: string;
    normalizedName: string;
    decision: string | null;
    /** Subjects carried forward from this level. */
    carrySubjectIds: number[];
    /** Subjects that must be repeated. */
    repeatSubjectIds: number[];
    /** Tokens no alias resolved — these are what flag the row. */
    unresolvedTokens: string[];
  };
}

/**
 * §6.2 result-sheet mapping, plus §6.4 step 4 (carried subjects resolved via
 * `subject_aliases`).
 *
 * An unresolved subject token makes the row an error rather than dropping the
 * subject: "never auto-create a subject", and silently importing a carry list
 * with one subject missing understates what a student still owes.
 */
export function parseResultRow(
  row: DataRow,
  studentsByNormalizedName: Map<string, ExistingStudent>,
  aliasesByNormalized: Map<string, number>,
): ResultRowParse {
  const fullName = (row.values.name ?? '').trim();
  const normalizedName = normalizeArabic(fullName);
  const decision = parseDecision(row.values.decision ?? '');

  const carry = resolveSubjects(
    splitSubjectList(row.values.carrySubjects ?? ''),
    aliasesByNormalized,
  );
  const priorCarry = resolveSubjects(
    splitSubjectList(row.values.priorLevelSubjects ?? ''),
    aliasesByNormalized,
  );
  const repeat = resolveSubjects(
    splitSubjectList(row.values.repeatSubjects ?? ''),
    aliasesByNormalized,
  );

  const unresolvedTokens = [...carry, ...priorCarry, ...repeat]
    .filter((resolution) => resolution.subjectId === null)
    .map((resolution) => resolution.token);

  const parsed = {
    fullName,
    normalizedName,
    decision,
    // The L3 أخوات sheet carries subjects from L2 in their own column
    // (§4.6/§6.1); both columns are carries and are merged here.
    carrySubjectIds: [...carry, ...priorCarry]
      .map((resolution) => resolution.subjectId)
      .filter((id): id is number => id !== null),
    repeatSubjectIds: repeat
      .map((resolution) => resolution.subjectId)
      .filter((id): id is number => id !== null),
    unresolvedTokens,
  };

  // The real L3 أخوات sheet has 18 outcome rows with no names at all (§6.3).
  if (normalizedName.length === 0) {
    return {
      action: 'error',
      error: 'Outcome row has no name to attach it to',
      matchStudentId: null,
      parsed,
    };
  }

  const existing = studentsByNormalizedName.get(normalizedName);
  if (!existing) {
    return {
      action: 'error',
      error: 'No enrolled student matches this name; import the roster first',
      matchStudentId: null,
      parsed,
    };
  }

  if (decision === null) {
    return {
      action: 'error',
      error: `Unrecognised decision: "${(row.values.decision ?? '').trim()}"`,
      matchStudentId: existing.id,
      parsed,
    };
  }

  if (unresolvedTokens.length > 0) {
    return {
      action: 'error',
      error: `Unrecognised subject(s): ${unresolvedTokens.join(', ')}`,
      matchStudentId: existing.id,
      parsed,
    };
  }

  return {
    action: 'update',
    error: null,
    matchStudentId: existing.id,
    parsed,
  };
}
