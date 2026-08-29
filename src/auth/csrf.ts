import { createHash } from 'crypto';
import { doubleCsrf } from 'csrf-csrf';
import type { Request } from 'express';

const REFRESH_COOKIE_NAME = 'refresh_token';

// No server-side sessions (JWT is stateless), so the CSRF secret is bound to
// a hash of the caller's refresh-token cookie rather than a session id.
// The csrf-token endpoint lives under /auth/refresh so this cookie (scoped
// to Path=/auth/refresh) is actually present when the token is issued.
function getSessionIdentifier(req: Request): string {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  return refreshToken
    ? createHash('sha256').update(refreshToken).digest('hex')
    : 'anonymous';
}

export const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET as string,
  getSessionIdentifier,
  cookieName: 'csrf_token',
  cookieOptions: {
    httpOnly: false, // client JS must read it to echo back via the x-csrf-token header
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/auth/refresh',
  },
  getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
});
