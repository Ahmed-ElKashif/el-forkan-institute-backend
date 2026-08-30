import { authCookieSecurity } from './cookie-security';

describe('authCookieSecurity', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to SameSite=Strict when COOKIE_SAMESITE is unset', () => {
    delete process.env.COOKIE_SAMESITE;
    expect(authCookieSecurity().sameSite).toBe('strict');
  });

  it('keeps Strict for any value other than "none"', () => {
    process.env.COOKIE_SAMESITE = 'strict';
    expect(authCookieSecurity().sameSite).toBe('strict');
    process.env.COOKIE_SAMESITE = 'lax';
    expect(authCookieSecurity().sameSite).toBe('strict');
  });

  it('switches to SameSite=None for a cross-site deploy', () => {
    process.env.COOKIE_SAMESITE = 'none';
    expect(authCookieSecurity().sameSite).toBe('none');
  });

  it('forces Secure when SameSite=None, even outside production', () => {
    process.env.COOKIE_SAMESITE = 'none';
    process.env.NODE_ENV = 'development';
    expect(authCookieSecurity().secure).toBe(true);
  });

  it('defaults Secure ON when COOKIE_SECURE is unset (F7 fail-safe)', () => {
    delete process.env.COOKIE_SAMESITE;
    delete process.env.COOKIE_SECURE;
    expect(authCookieSecurity().secure).toBe(true);
  });

  it('leaves the cookie insecure only when COOKIE_SECURE is explicitly false', () => {
    delete process.env.COOKIE_SAMESITE;
    process.env.COOKIE_SECURE = 'false';
    expect(authCookieSecurity().secure).toBe(false);
  });

  it('forces Secure under SameSite=None even if COOKIE_SECURE=false', () => {
    process.env.COOKIE_SAMESITE = 'none';
    process.env.COOKIE_SECURE = 'false';
    expect(authCookieSecurity().secure).toBe(true);
  });
});
