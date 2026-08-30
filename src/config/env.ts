import { z } from 'zod';

/**
 * §1.3 — configuration is validated once, at boot, instead of being read from
 * `process.env` with `as string` casts scattered across five files that lie to
 * the type system. A missing `JWT_ACCESS_SECRET` now aborts the process on
 * startup with a named error, rather than surfacing as a 500 on the first
 * login. `common/field-encryption.ts` already validated its key this way — this
 * generalises that pattern, and F6 (CORS) and F7 (cookie Secure) fall out of it.
 *
 * The schema deliberately validates only the variables the application reads;
 * unknown keys pass through untouched, so it never fights the platform's own
 * injected environment.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    // Database. DIRECT_URL is only used by Prisma migrations, so it is optional
    // for the running server.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DIRECT_URL: z.string().min(1).optional(),

    // Auth secrets. A short secret is worse than a missing one because it looks
    // configured, so a minimum length is enforced rather than mere presence.
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    REFRESH_TOKEN_PEPPER: z.string().optional(),
    CSRF_SECRET: z
      .string()
      .min(16, 'CSRF_SECRET must be at least 16 characters'),

    // AES-256-GCM key for students.national_id_enc. field-encryption.ts checks
    // the decoded byte length; this catches a wholly missing value at boot.
    FIELD_ENCRYPTION_KEY: z.string().min(1, 'FIELD_ENCRYPTION_KEY is required'),

    // App / HTTP. CORS_ORIGIN is a comma-separated allowlist (F6). It is required
    // in production so a deploy cannot silently fall back to serving every origin.
    CORS_ORIGIN: z.string().optional(),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),

    // Cross-site policy for the auth cookies. `none` forces Secure regardless.
    COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    // F7: Secure defaults ON. Local HTTP development is the one case that must
    // opt out explicitly, with COOKIE_SECURE=false.
    COOKIE_SECURE: z.enum(['true', 'false']).optional(),

    // Messaging — optional: §7.8 says Meta approval "takes days", so the app must
    // boot and run without it.
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.CORS_ORIGIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message:
          'CORS_ORIGIN must be set in production (comma-separated allowlist); refusing to fall back to "*"',
      });
    }
  });

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

/**
 * Parses and validates `process.env`. Call once, first thing in bootstrap,
 * before Nest constructs any provider that reads configuration. Throws a single
 * error listing every problem rather than failing one variable at a time.
 */
export function validateEnv(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${details}\n` +
        'Fix these variables (see .env.example) before starting the server.',
    );
  }
  cached = parsed.data;
  return parsed.data;
}

/** The validated config. Call `validateEnv()` first (bootstrap does). */
export function getEnv(): AppEnv {
  return cached ?? validateEnv();
}

/**
 * Reads a required variable, asserting it is present. A convenience for the few
 * provider field initialisers that need a secret at construction time; by then
 * `validateEnv()` has already guaranteed it, so this never actually throws in a
 * correctly-booted process — it exists to give the value a non-null type
 * without an `as string` cast.
 */
export function requireEnv(name: keyof AppEnv): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** The parsed, de-duplicated CORS allowlist (F6). Empty when unset. */
export function corsAllowlist(): string[] {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ];
}
