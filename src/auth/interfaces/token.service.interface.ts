import type { user_role_t } from '@prisma/client';

export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

export interface AccessTokenPayload {
  sub: string; // user id
  role: user_role_t;
  // Branch scoping predicate (spec §3). NULL means "all branches" — the
  // institute-wide head teacher. Carried in the token rather than looked up,
  // so scoping costs no query; a branch reassignment takes effect within the
  // access token's 15-minute lifetime.
  branchId: number | null;
}

export interface RefreshTokenPair {
  token: string; // raw opaque value returned to the client
  tokenHash: string; // what actually gets stored (refresh_tokens.token_hash)
}

export interface ITokenService {
  signAccessToken(payload: AccessTokenPayload): string;
  verifyAccessToken(token: string): AccessTokenPayload;
  generateRefreshToken(): RefreshTokenPair;
  hashRefreshToken(token: string): string;
}
