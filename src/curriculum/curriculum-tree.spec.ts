import { buildCurriculumTree } from './curriculum-tree';

// Shaped like the real L1 syllabus: اللغة العربية is a container whose
// children النحو and البلاغة hold the exams (spec §4.1).
const ARABIC = { id: 1, parentCurriculumId: null, name: 'اللغة العربية' };
const NAHW = { id: 2, parentCurriculumId: 1, name: 'النحو' };
const BALAGHA = { id: 3, parentCurriculumId: 1, name: 'البلاغة' };
const FIQH = { id: 4, parentCurriculumId: null, name: 'الفقه' };

describe('buildCurriculumTree', () => {
  it('nests children under the parent they name', () => {
    const tree = buildCurriculumTree([ARABIC, NAHW, BALAGHA, FIQH]);

    expect(tree.map((node) => node.id)).toEqual([1, 4]);
    expect(tree[0].children.map((child) => child.name)).toEqual([
      'النحو',
      'البلاغة',
    ]);
    expect(tree[1].children).toEqual([]);
  });

  it('does not depend on children arriving after their parent', () => {
    const tree = buildCurriculumTree([BALAGHA, FIQH, NAHW, ARABIC]);

    expect(tree.find((node) => node.id === 1)?.children).toHaveLength(2);
  });

  // Filtering by level or term can slice a parent out of the result set. A
  // subject silently disappearing from the head teacher's screen is worse
  // than showing it at the top level, because nothing signals the loss.
  it('surfaces a child whose parent is outside the filtered rows', () => {
    const tree = buildCurriculumTree([NAHW]);

    expect(tree.map((node) => node.id)).toEqual([2]);
    expect(tree[0].children).toEqual([]);
  });

  it.each([
    ['no rows', []],
    ['only children with no parents present', [NAHW, BALAGHA]],
  ])('handles %s without throwing', (_label, rows) => {
    expect(() => buildCurriculumTree(rows)).not.toThrow();
  });

  it('never mutates the rows it was given', () => {
    const rows = [ARABIC, NAHW];
    const snapshot = JSON.stringify(rows);

    buildCurriculumTree(rows);

    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});
