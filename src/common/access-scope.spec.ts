import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  canAccessSection,
  enrollmentScope,
  sectionScope,
} from './access-scope';

const ASWAN = 1;
const CAIRO = 2;

const INSTITUTE_HEAD: AuthenticatedUser = {
  id: 'head',
  role: 'head_teacher',
  branchId: null,
};
const BRANCH_HEAD: AuthenticatedUser = {
  id: 'branch-head',
  role: 'head_teacher',
  branchId: ASWAN,
};
const TEACHER_A: AuthenticatedUser = {
  id: 'teacher-a',
  role: 'teacher',
  branchId: ASWAN,
};

const sectionRow = (
  branchId: number,
  teacherIds: string[],
): { branch_id: number; section_teachers: Array<{ user_id: string }> } => ({
  branch_id: branchId,
  section_teachers: teacherIds.map((user_id) => ({ user_id })),
});

describe('sectionScope', () => {
  // §3: a head teacher with branch_id NULL sees all branches.
  it('applies no restriction at all for the institute-wide head teacher', () => {
    expect(sectionScope(INSTITUTE_HEAD)).toEqual({});
  });

  it('confines a branch-scoped head teacher to her branch, but not to her own sections', () => {
    expect(sectionScope(BRANCH_HEAD)).toEqual({ branch_id: ASWAN });
  });

  // The rule spec §9 calls "the bug class that actually ships".
  it('confines a teacher to sections they are assigned to', () => {
    expect(sectionScope(TEACHER_A)).toEqual({
      branch_id: ASWAN,
      section_teachers: { some: { user_id: 'teacher-a' } },
    });
  });
});

describe('enrollmentScope', () => {
  it('applies no restriction for the institute-wide head teacher', () => {
    expect(enrollmentScope(INSTITUTE_HEAD)).toEqual({});
  });

  it('scopes a teacher through the section, not through a duplicated branch column', () => {
    expect(enrollmentScope(TEACHER_A)).toEqual({
      section: {
        branch_id: ASWAN,
        section_teachers: { some: { user_id: 'teacher-a' } },
      },
    });
  });

  it('still scopes a branch-confined head teacher', () => {
    expect(enrollmentScope(BRANCH_HEAD)).toEqual({
      section: { branch_id: ASWAN },
    });
  });
});

describe('canAccessSection', () => {
  it('lets the institute-wide head teacher into any section', () => {
    expect(
      canAccessSection(INSTITUTE_HEAD, sectionRow(CAIRO, ['someone-else'])),
    ).toBe(true);
  });

  it('lets a head teacher into a section in her branch she does not teach', () => {
    expect(
      canAccessSection(BRANCH_HEAD, sectionRow(ASWAN, ['someone-else'])),
    ).toBe(true);
  });

  it('keeps a branch head out of another branch', () => {
    expect(canAccessSection(BRANCH_HEAD, sectionRow(CAIRO, []))).toBe(false);
  });

  // THE test spec §9 asks for: teacher A cannot reach section B.
  it('lets a teacher into their own section', () => {
    expect(canAccessSection(TEACHER_A, sectionRow(ASWAN, ['teacher-a']))).toBe(
      true,
    );
  });

  it("keeps a teacher out of another teacher's section in the same branch", () => {
    expect(canAccessSection(TEACHER_A, sectionRow(ASWAN, ['teacher-b']))).toBe(
      false,
    );
  });

  it('keeps a teacher out of an unassigned section', () => {
    expect(canAccessSection(TEACHER_A, sectionRow(ASWAN, []))).toBe(false);
  });

  it('keeps a teacher out of a section in another branch even if assigned', () => {
    expect(canAccessSection(TEACHER_A, sectionRow(CAIRO, ['teacher-a']))).toBe(
      false,
    );
  });
});
