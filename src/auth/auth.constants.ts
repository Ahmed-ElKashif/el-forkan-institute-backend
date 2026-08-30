/**
 * One home for the auth policy constants that were previously copied across
 * auth.controller.ts, auth.service.ts and csrf.ts (§1.5). Two copies of the
 * same 7-day refresh policy — the cookie `maxAge` and the DB `expires_at` —
 * had drifted apart in principle even where they agreed by luck; deriving both
 * from `REFRESH_TOKEN_TTL_MS` here makes them one number.
 */

/** Name of the httpOnly refresh-token cookie. */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Path scope for the refresh cookie — also where the CSRF cookie is bound. */
export const REFRESH_COOKIE_PATH = '/auth/refresh';

/** 7 days, in milliseconds. Drives both the cookie maxAge and the DB expiry. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Account-lockout policy (auth.service). */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** Access-token lifetime and the claims pinned on verify (F8). */
export const ACCESS_TOKEN_TTL = '15m';
export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_ISSUER = 'el-forkan-institute';
export const JWT_AUDIENCE = 'el-forkan-institute-api';
