import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * The authorization scope layer (spec §9: "one guard, one policy layer,
 * filtering at the repository level by the user's `section_teachers` rows and
 * `branch_id`, never in controllers").
 *
 * Every function here returns a Prisma where-fragment. Callers spread it into
 * a query; nothing composes a scoped query by hand, so there is no unscoped
 * path for someone to take by accident.
 *
 * Two axes, and they compose:
 *
 * - **Branch** (§3). `users.branch_id IS NULL` means institute-wide — today
 *   only the head teacher. Everyone else is confined to their own branch, and
 *   adding the future `branch_head` role is a change here, not an audit of
 *   every query.
 * - **Section assignment**. A teacher sees the sections they teach, via
 *   `section_teachers`. The head teacher has no such restriction: §3 gives her
 *   "Record attendance ✅ all" and "Export / print rosters ✅ all".
 */

const HEAD_TEACHER = 'head_teacher';

function isHeadTeacher(viewer: AuthenticatedUser): boolean {
  return viewer.role === HEAD_TEACHER;
}

/** Restricts a query on `sections` to what this viewer may see. */
export function sectionScope(
  viewer: AuthenticatedUser,
): Prisma.sectionsWhereInput {
  return {
    ...(viewer.branchId === null ? {} : { branch_id: viewer.branchId }),
    ...(isHeadTeacher(viewer)
      ? {}
      : { section_teachers: { some: { user_id: viewer.id } } }),
  };
}

/**
 * Restricts a query on `enrollments`. Written as a nested `sections` filter
 * rather than duplicating the branch predicate against `enrollments.branch_id`
 * — the denormalised column exists to let the composite FK enforce
 * consistency (§5.1), not to become a second place the scope rule is spelled
 * out and can drift.
 */
export function enrollmentScope(
  viewer: AuthenticatedUser,
): Prisma.enrollmentsWhereInput {
  if (isHeadTeacher(viewer) && viewer.branchId === null) {
    return {};
  }
  return { section: sectionScope(viewer) };
}

/**
 * Whether this viewer may act on one specific section. Used for writes, where
 * a where-fragment is not enough because the row is addressed by id.
 *
 * Returns a *predicate over a loaded section* rather than performing the
 * lookup, so callers that already hold the row do not fetch it twice.
 */
export function canAccessSection(
  viewer: AuthenticatedUser,
  section: { branch_id: number; section_teachers: Array<{ user_id: string }> },
): boolean {
  if (viewer.branchId !== null && section.branch_id !== viewer.branchId) {
    return false;
  }
  if (isHeadTeacher(viewer)) {
    return true;
  }
  return section.section_teachers.some(
    (assignment) => assignment.user_id === viewer.id,
  );
}
