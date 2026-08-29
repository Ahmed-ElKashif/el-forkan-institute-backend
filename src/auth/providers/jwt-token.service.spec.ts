process.env.JWT_ACCESS_SECRET = 'test-secret-do-not-use-in-prod';
process.env.REFRESH_TOKEN_PEPPER = 'test-pepper';

import { JwtService } from '@nestjs/jwt';
import { JwtTokenService } from './jwt-token.service';

describe('JwtTokenService', () => {
  const service = new JwtTokenService(new JwtService({}));
  const payloadFor = (branchId: number | null) => ({
    sub: 'user-1',
    role: 'teacher',
    branchId,
  });

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
