/**
 * Local-harness authentication for the smoke suites.
 *
 * WHY THIS EXISTS
 * Sign-in is two-factor (F12): `POST /auth/login` returns a challenge, and the
 * session is only issued by `POST /auth/verify-otp` with a code that is emailed
 * and stored hashed. A script cannot read that code back, so the older suites —
 * which expected `login` to hand them an `accessToken` — stopped working the
 * day 2FA landed.
 *
 * Rather than weaken the login path for testing, the harness signs its own
 * access token with the same secret and claims the server verifies. That keeps
 * the production flow untouched: nothing here is imported by `src/`, and a
 * token is only mintable by someone who already holds JWT_ACCESS_SECRET.
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const env = Object.fromEntries(
  readFileSync(join(here, '..', '..', '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [
        l.slice(0, i).trim(),
        l.slice(i + 1).trim().replace(/^["']|["']$/g, ''),
      ];
    }),
);

// Must match src/auth/auth.constants.ts — the guard pins all three.
const ISSUER = 'el-forkan-institute';
const AUDIENCE = 'el-forkan-institute-api';
const TTL_SECONDS = 15 * 60;

const b64 = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

/** Mints an HS256 access token for a user the server will accept. */
export function tokenFor({ userId, role, branchId = null }) {
  const secret = env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET missing from .env');

  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(
    JSON.stringify({
      sub: userId,
      role,
      branchId,
      iat: now,
      exp: now + TTL_SECONDS,
      iss: ISSUER,
      aud: AUDIENCE,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.${signature}`;
}
