/**
 * Nests flat curriculum rows into the parent/child shape of §4.1.
 *
 * Pure and separate from the service so the nesting rules can be tested
 * without a database: the hierarchy is the part of the curriculum that is easy
 * to get subtly wrong (an orphan silently disappearing from the tree is the
 * failure mode), and it is read on every curriculum screen.
 */

// The application layer caps nesting at two levels (§4.1): a مادة and its
// فروع. Anything deeper is rejected at write time, so the reader never has to
// recurse.
export const MAX_NESTING_DEPTH = 2;

export interface FlatCurriculumRow {
  id: number;
  parentCurriculumId: number | null;
}

export type CurriculumNode<T extends FlatCurriculumRow> = T & {
  children: T[];
};

export function buildCurriculumTree<T extends FlatCurriculumRow>(
  rows: T[],
): CurriculumNode<T>[] {
  const roots: CurriculumNode<T>[] = [];
  const byId = new Map<number, CurriculumNode<T>>();

  for (const row of rows) {
    if (row.parentCurriculumId === null) {
      const node = { ...row, children: [] };
      byId.set(row.id, node);
      roots.push(node);
    }
  }

  for (const row of rows) {
    if (row.parentCurriculumId === null) continue;
    const parent = byId.get(row.parentCurriculumId);
    if (parent) {
      parent.children.push(row);
      continue;
    }
    // A child whose parent is not in this result set — the caller filtered by
    // level or term and the parent fell outside it. Dropping it would make a
    // subject vanish from the screen with no error, so it is surfaced as a
    // root instead.
    roots.push({ ...row, children: [] });
  }

  return roots;
}
