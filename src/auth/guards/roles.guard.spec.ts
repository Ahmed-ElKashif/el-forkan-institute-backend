import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { user_role_t } from '@prisma/client';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { RolesGuard } from './roles.guard';

function buildGuard(
  requiredRoles: user_role_t[] | undefined,
  user: AuthenticatedUser | undefined,
) {
  const reflector = {
    getAllAndOverride: () => requiredRoles,
  } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
  return { guard: new RolesGuard(reflector), context };
}

const HEAD_TEACHER: AuthenticatedUser = {
  id: 'u1',
  role: 'head_teacher',
  branchId: null,
};
const TEACHER: AuthenticatedUser = { id: 'u2', role: 'teacher', branchId: 1 };

describe('RolesGuard', () => {
  // Spec §3: the capability table has rows open to both roles, and those
  // routes carry no @Roles() at all.
  it.each([
    ['no metadata', undefined],
    ['an empty role list', [] as user_role_t[]],
  ])('allows any authenticated user through a route with %s', (_l, roles) => {
    const { guard, context } = buildGuard(roles, TEACHER);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a role that is on the list', () => {
    const { guard, context } = buildGuard(['head_teacher'], HEAD_TEACHER);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a teacher from a head-teacher-only route', () => {
    const { guard, context } = buildGuard(['head_teacher'], TEACHER);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // Reached only if a restricted route is also marked @Public(), which is a
  // wiring mistake. Failing closed means the mistake is a 403, not an open door.
  it('rejects a restricted route reached with no authenticated user', () => {
    const { guard, context } = buildGuard(['head_teacher'], undefined);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
