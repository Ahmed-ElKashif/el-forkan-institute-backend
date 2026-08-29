// Spec §3: "users.branch_id exists now and every query is branch-scoped ...
// A head teacher with branch_id IS NULL sees all branches." Expressed as a
// Prisma where-fragment so scoping happens in the repository, never in a
// controller (spec §9), and so adding the future `branch_head` role is one
// call site rather than an audit of every query.
export function branchScope(actorBranchId: number | null): {
  branch_id?: number;
} {
  return actorBranchId === null ? {} : { branch_id: actorBranchId };
}
