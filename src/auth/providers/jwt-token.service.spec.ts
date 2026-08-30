process.env.JWT_ACCESS_SECRET = 'test-secret-do-not-use-in-prod';
process.env.REFRESH_TOKEN_PEPPER = 'test-pepper';

import { JwtService } from '@nestjs/jwt';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER } from '../auth.constants';
import { JwtTokenService } from './jwt-token.service';

describe('JwtTokenService', () => {
  const secret = process.env.JWT_ACCESS_SECRET as string;
  const rawJwt = new JwtService({});
  const service = new JwtTokenService(rawJwt);
  const payloadFor = (branchId: number | null) =>
    ({
      sub: 'user-1',
      role: 'teacher',
      branchId,
    }) as const;

  it('signs and verifies an access token round-trip', () => {
    const token = service.signAccessToken(payloadFor(3));
    const payload = service.verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('teacher');
    expect(payload.branchId).toBe(3);
  });

  it('rejects a tampered access token', () => {
    const token = service.signAccessToken(payloadFor(null));
    expect(() => service.verifyAccessToken(token + 'tampered')).toThrow();
  });

  // F8: a token signed with the right key/issuer/audience but a role claim that
  // is not a real user_role_t must be rejected, not propagated into request.user.
  it('rejects a token whose role claim is not a known role', () => {
    const forged = rawJwt.sign(
      { sub: 'user-1', role: 'super_admin', branchId: 1 },
      {
        secret,
        algorithm: JWT_ALGORITHM,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    expect(() => service.verifyAccessToken(forged)).toThrow();
  });

  // F8: the algorithm/issuer/audience are pinned on verify.
  it('rejects a validly-shaped token signed for a different audience', () => {
    const wrongAudience = rawJwt.sign(
      { sub: 'user-1', role: 'teacher', branchId: 1 },
      {
        secret,
        algorithm: JWT_ALGORITHM,
        issuer: JWT_ISSUER,
        audience: 'some-other-api',
      },
    );
    expect(() => service.verifyAccessToken(wrongAudience)).toThrow();
  });

  it('generates a refresh token whose hash matches recomputing the hash, but the raw token is never stored as-is', () => {
    const { token, tokenHash } = service.generateRefreshToken();
    expect(token).not.toBe(tokenHash);
    expect(service.hashRefreshToken(token)).toBe(tokenHash);
  });

  it('generates a different refresh token every call (sufficient entropy)', () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
  });
});
