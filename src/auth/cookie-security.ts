import type { CookieOptions } from 'express';

/**
 * SameSite/Secure for the two auth cookies — the refresh token and the CSRF
 * token — computed in one place so they can never disagree.
 *
 * Default `strict`: correct for local dev, and for a deploy where the API and
 * the SPA share one registrable domain (e.g. api.example.org + app.example.org),
 * which SameSite treats as the same site.
 *
 * Set `COOKIE_SAMESITE=none` for a deploy where the two are cross-site — most
 * importantly two separate `*.onrender.com` subdomains, which the Public Suffix
 * List makes distinct sites. A `Strict` cookie is then silently dropped on every
 * cross-site request: the refresh cookie never reaches `POST /auth/refresh`, so
 * login appears to work but every token refresh fails after deploy. `None`
 * requires the Secure attribute, so it forces `secure` on regardless.
 * See backend/agent/memory.md and the frontend build plan (F0d).
 *
 * F7: `secure` now defaults ON and fails safe. Previously it was gated on
 * `NODE_ENV === 'production'`, but NODE_ENV is not in `.env.example` and
 * `start:prod` does not set it, so a by-the-book production deploy shipped the
 * refresh token over cleartext HTTP. Local HTTP development is the one context
 * that must send an insecure cookie, and it now opts out explicitly with
 * `COOKIE_SECURE=false`.
 */
export function authCookieSecurity(): Required<
  Pick<CookieOptions, 'sameSite' | 'secure'>
> {
  const crossSite = process.env.COOKIE_SAMESITE === 'none';
  return {
    sameSite: crossSite ? 'none' : 'strict',
    // Secure unless a developer explicitly turns it off; SameSite=None forces
    // it regardless, because browsers reject an insecure None cookie.
    secure: crossSite || process.env.COOKIE_SECURE !== 'false',
  };
}
