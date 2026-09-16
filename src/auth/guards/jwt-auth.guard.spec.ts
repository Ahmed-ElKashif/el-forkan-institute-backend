import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { ITokenService, AccessTokenPayload } from '../interfaces/token.service.interface';

const VALID_PAYLOAD: AccessTokenPayload = { sub: 'user-1', role: 'head_teacher', branchId: null };

function contextWithHeader(authorization?: string) {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  return {
    request,
    context: {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

function buildGuard(
  isPublic: boolean,
  verify: ITokenService['verifyAccessToken'],
) {
  const reflector = {
    getAllAndOverride: () => isPublic,
  } as unknown as Reflector;
  const tokenService = { verifyAccessToken: verify } as ITokenService;
  return new JwtAuthGuard(reflector, tokenService);
}

describe('JwtAuthGuard', () => {
  it('lets a @Public() route through without inspecting the header', () => {
    const verify = jest.fn();
    const { context } = contextWithHeader();

    expect(buildGuard(true, verify).canActivate(context)).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('attaches the token subject and role to the request', () => {
    const { context, request } = contextWithHeader('Bearer good-token');

    expect(buildGuard(false, () => VALID_PAYLOAD).canActivate(context)).toBe(
      true,
    );
    expect(request.user).toEqual({
      id: 'user-1',
      role: 'head_teacher',
      branchId: null,
    });
  });

  // Boundary cases for the Authorization header: absent, scheme-only, wrong
  // scheme, right scheme with an empty token, right scheme with a bad token.
  it.each([
    ['no header at all', undefined],
    ['scheme with no token', 'Bearer'],
    ['the wrong scheme', 'Basic good-token'],
    ['a lowercase scheme', 'bearer good-token'],
    ['an empty token', 'Bearer '],
  ])('rejects %s', (_label, header) => {
    const { context } = contextWithHeader(header);
    const guard = buildGuard(false, () => VALID_PAYLOAD);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('reports an unverifiable token as unauthorized, not as a crash', () => {
    const { context } = contextWithHeader('Bearer tampered');
    const guard = buildGuard(false, () => {
      throw new Error('invalid signature');
    });

    expect(() => guard.canActivate(context)).toThrow(
      'Invalid or expired access token',
    );
  });
});
