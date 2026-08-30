import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'crypto';
import { user_role_t } from '@prisma/client';
import { z } from 'zod';
import {
  ACCESS_TOKEN_TTL,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../auth.constants';
import { requireEnv } from '../../config/env';
import {
  AccessTokenPayload,
  ITokenService,
  RefreshTokenPair,
} from '../interfaces/token.service.interface';

const REFRESH_TOKEN_BYTES = 32;

// F8: the claim shape is validated on every verify, so a token signed with the
// right key but a malformed `role` (or a missing `sub`) is rejected here rather
// than propagating an invalid value into request.user and on into RolesGuard.
const AccessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(user_role_t),
  branchId: z.number().int().nullable(),
});

@Injectable()
export class JwtTokenService implements ITokenService {
  // Validated once at boot by the env schema (§1.3); read here rather than
  // cast, so a missing secret has already aborted the process.
  private readonly accessSecret = requireEnv('JWT_ACCESS_SECRET');
  private readonly refreshPepper = process.env.REFRESH_TOKEN_PEPPER ?? '';

  constructor(private readonly jwt: JwtService) {}

  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwt.sign(payload, {
      secret: this.accessSecret,
      expiresIn: ACCESS_TOKEN_TTL,
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    // Pinning the algorithm allowlist is defence-in-depth today (the key is
    // symmetric, so `alg: none` and the RS256→HS256 confusion are already
    // rejected) and a hard requirement the day this moves to the asymmetric
    // Supabase JWKS in .env.example — see report F8.
    const decoded = this.jwt.verify<Record<string, unknown>>(token, {
      secret: this.accessSecret,
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return AccessTokenPayloadSchema.parse(decoded);
  }

  generateRefreshToken(): RefreshTokenPair {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    return { token, tokenHash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256')
      .update(token + this.refreshPepper)
      .digest('hex');
  }
}
