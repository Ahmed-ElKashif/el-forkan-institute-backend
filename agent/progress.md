# Progress — Phase 0 milestone log

Mirrors the "Teaching sequence" section of the Phase 0 plan. One entry per
milestone, updated as we go.

## Milestone 1 — Nest fundamentals ✅ done

- Explained modules/controllers/providers/DI (the request-flow triad).
- Scaffolded `backend/` via the Nest CLI (`nest new backend`).
- Booted the dev server (`npm run start:dev`), verified `GET /` returned
  `"Hello World!"` — proved the Controller → Service DI loop works.
- Replaced the boilerplate with a real `GET /health` route
  (`app.controller.ts` / `app.service.ts`), returning
  `{ status: 'ok', timestamp }`. Verified hot-reload picked up the change
  without restarting the dev server, and that the old `/` route now 404s.
- Updated `app.controller.spec.ts` to match.

## Milestone 2 — Schema + Prisma groundwork ✅ done

- Added `username` to `schema-v1.1.sql` `users` table.
- Installed `prisma` + `@prisma/client` (v7.9.1) into `backend/`.
- Password issue resolved (user reset the Supabase DB password) — see
  memory.md "Gotchas" for the full diagnosis trail.
- Applied `schema-v1.1.sql` to the live Supabase DB via
  `npx prisma db execute --file ../schema-v1.1.sql` — succeeded.
- `npx prisma db pull` introspected all 39 tables into `backend/prisma/schema.prisma`.
- Hit and fixed two Prisma-7-specific introspection issues on `section_teachers`
  (composite FKs to `sections`/`users` sharing a column with a single-column
  FK) — see memory.md "Prisma introspection gotchas". Neither required
  changing the actual data model, only how Prisma represents it.
- `npx prisma generate` succeeded.
- Installed `@prisma/adapter-pg` + `pg` (Prisma 7 requires a driver adapter
  at runtime — `schema.prisma` no longer carries a connection `url`).
- Wrote `PrismaService` (`src/prisma/prisma.service.ts`, extends
  `PrismaClient`, `OnModuleInit`/`OnModuleDestroy` lifecycle, `$connect()` /
  `$disconnect()`) and `PrismaModule` (`@Global()`, exports `PrismaService`).
  Wired into `AppModule`.
- **Verified live**: clean dev-server restart shows
  `PrismaModule dependencies initialized` and `Nest application successfully
  started` — confirms `PrismaService` actually connected to the live Supabase
  DB on boot, not just that the code compiles.

## Milestone 3 — Validation layer ✅ done

- Installed `zod` + `nestjs-zod`.
- `src/auth/dto/login.schema.ts`: `LoginSchema` (zod) → `LoginDto` (via
  `createZodDto`). `.strict()` rejects unknown fields (the zod equivalent of
  `forbidNonWhitelisted: true`). Password capped at 72 **bytes**, not
  characters — checked via `Buffer.byteLength(value, 'utf8')`, not `.max()`
  on the string, since multi-byte UTF-8 (Arabic text especially, given this
  app's whole userbase) can exceed 72 bytes well under 72 characters.
- `src/auth/dto/login.schema.spec.ts`: 5 Jest tests, including one that
  specifically proves the byte-vs-character distinction matters (40 Arabic
  characters = under the char limit, over the byte limit). All passing.
- Wired `app.useGlobalPipes(new ZodValidationPipe())` in `main.ts`.
- No live route consumes `LoginDto` yet (that's Milestone 5) — verified via
  unit tests and a clean dev-server reboot, per the plan's "without a live
  Supabase project" verification tier (this part doesn't even need the DB).

## Milestone 4 — SOLID applied to Auth ✅ done

- `src/auth/interfaces/password-hasher.interface.ts` — `IPasswordHasher` +
  `PASSWORD_HASHER` DI token (Symbol).
- `src/auth/interfaces/token.service.interface.ts` — `ITokenService` +
  `TOKEN_SERVICE` DI token, `AccessTokenPayload`/`RefreshTokenPair` types.
- `src/auth/providers/bcrypt-password-hasher.ts` — `BcryptPasswordHasher`
  (cost 12) implements `IPasswordHasher`.
- `src/auth/providers/jwt-token.service.ts` — `JwtTokenService` implements
  `ITokenService`: 15-min JWT access tokens via `@nestjs/jwt`'s
  `JwtService`; opaque 32-byte refresh tokens hashed with SHA-256 +
  `REFRESH_TOKEN_PEPPER`.
- `src/users/users.repository.ts` + `users.module.ts` — `UsersRepository`
  wraps Prisma `users` calls (`findByUsername`, `findById`), exported for
  `AuthModule` to consume next milestone.
- `src/auth/auth.module.ts` — registers both providers via `useClass` against
  their DI tokens; imports `JwtModule.register({})` + `UsersModule`. Wired
  into `AppModule`.
- Filled in three previously-empty secrets in `backend/.env`
  (`JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, `CSRF_SECRET`) — generated
  cryptographically random values directly rather than asking the user to
  invent local dev secrets. Along the way found and fixed a real bug: the
  `.env` line for `REFRESH_TOKEN_PEPPER` had a trailing inline comment
  (`# optional extra input...`) that a naive same-line parser would mis-read
  as part of the value — `dotenv` itself handles this correctly, but it's
  worth remembering `.env` inline comments are fragile.
- **Verified live**: clean dev-server restart shows `PrismaModule`,
  `JwtModule`, `UsersModule`, and `AuthModule` all initializing with zero DI
  resolution errors — proves the `useClass`-against-token wiring is correct,
  not just that the code compiles.
- 12 Jest tests passing across `login.schema`, `bcrypt-password-hasher`, and
  `jwt-token.service` (round-trip sign/verify, tamper rejection, refresh
  token hash/regenerate behavior, bcrypt salting).

## Milestone 5 — Auth implementation ✅ done

- `src/auth/auth.service.ts` — `AuthService.login/refresh/logout`, orchestrating
  `UsersRepository` + the two Milestone 4 providers. Failed-login counter
  (locks after 5 attempts, 15 min), refresh-token rotation, stolen-token
  family revocation, soft-delete/inactive checks.
- `src/auth/auth.controller.ts` — `POST /auth/login|refresh|logout`, HTTP-only
  (cookie setting, status codes), delegates everything else to `AuthService`.
  Refresh cookie: httpOnly, `SameSite=Strict`, `Path=/auth/refresh`, 7d,
  `Secure` only when `NODE_ENV=production` (browsers won't send `Secure`
  cookies over local `http://`, so this is conditional by necessity — see
  spec §7.10 for the Render-deployment implication once this matters again).
- `src/users/users.mapper.ts` — `toPublicUser()` strips `password_hash`/
  `failed_logins`/`locked_until`/delete metadata before anything reaches an
  API response.
- `cookie-parser` wired into `main.ts` for reading the refresh cookie.
- `prisma/seed-head-teacher.ts` — one-off script that seeded a placeholder
  `head_teacher` account (`username: headteacher`, temp password) for testing.
  **Not the institute's real head-teacher account** — replace or update
  before real use.

**Two real bugs found and fixed while verifying this end-to-end** (full
diagnosis in memory.md "Gotchas"):
1. `isolatedModules`/`emitDecoratorMetadata` requires interface types used in
   a decorated constructor parameter (`@Inject(...) x: ISomething`) to be
   imported via `import type` — TS1272, fixed in `auth.service.ts`.
2. **The big one**: `main.ts` never loaded `.env` at all — NestJS does not
   auto-load env files (unlike some frameworks), and nothing in the app ever
   called `dotenv.config()`. Every env-dependent thing (`DATABASE_URL`,
   `JWT_ACCESS_SECRET`, etc.) had been silently `undefined` at runtime this
   whole time; `PrismaService` was falling back to a default local
   connection, which is why every `.env` edit across Milestones 2–5 had zero
   effect on the running app (CLI tools and standalone scripts worked fine
   because *they* called `dotenv.config()` themselves). Fixed with
   `import 'dotenv/config'` as the literal first line of `main.ts`, plus
   installing `dotenv` as an explicit dependency (it was only ever a
   transitive one). Separately and additionally, `sslmode=require` in the
   connection strings fails against Supabase's pooler cert once loaded for
   real (newer `pg-connection-string` treats `require` as full CA
   verification) — switched to `sslmode=no-verify` in both `DATABASE_URL`
   and `DIRECT_URL`.

**Verified live, full flow via curl**: login → correct cookie flags + JWT +
`password_hash` excluded from response → refresh rotates the cookie → reusing
the old consumed cookie triggers `401 Refresh token reuse detected` **and**
revokes the whole family (the newest legit cookie is immediately rejected
too) → logout clears the cookie client-side and refresh afterward fails →
5 wrong-password attempts locks the account (`403` even with the correct
password) → lockout reset → `ZodValidationPipe` rejects a missing field and
an unrecognized extra field on the real route (not just in unit tests) →
legit login still succeeds after all of the above.

## Milestone 6 — Global hardening (helmet/cors/hpp/throttler/csrf-csrf) ✅ done

- `main.ts`: `helmet()` with explicit CSP (`default-src 'self'`, per spec
  §7.3/§9), `cors()` scoped to `CORS_ORIGIN` with `credentials: true` (cookies
  cross-origin), `hpp()` — all wired before `cookieParser()`/the validation
  pipe.
- `src/app.module.ts`: `ThrottlerModule.forRoot([{ name: 'default', ttl:
  60_000, limit: 100 }])` + global `APP_GUARD` → `ThrottlerGuard` (IP-based
  floor across every route).
- `src/auth/guards/login-throttler.guard.ts`: `LoginThrottlerGuard` — keys on
  `${ip}:${username}` instead of IP alone (spec §7.3: "IP-only is trivially
  bypassed"). Applied to `POST /auth/login` alongside `@Throttle({ default:
  { limit: 5, ttl: 60_000 } })`, layered on top of (not replacing) the global
  IP-only guard.
- `src/auth/csrf.ts`: `doubleCsrf()` from `csrf-csrf` (the spec's explicit
  pick over the unmaintained `csurf`). Session identifier is a SHA-256 hash
  of the caller's refresh-token cookie (no server sessions to bind to
  otherwise) — see memory.md for why the token endpoint had to live under
  `/auth/refresh`'s own path.
- `GET /auth/refresh/csrf-token` (new route) issues the token;
  `doubleCsrfProtection` middleware applied via `AuthModule implements
  NestModule` — scoped to `POST /auth/refresh` only, per spec ("the only
  CSRF surface"), not globally.
- ESLint: added a `no-restricted-syntax` rule banning
  `$queryRawUnsafe`/`$executeRawUnsafe` (spec §9 security checklist item,
  found while cross-checking the spec against what had actually been built).
  Verified it actually fires (tested against a throwaway violation, then
  removed it) rather than trusting the config blindly.
- Also cleaned up accumulated lint drift from Milestones 3–5 (prettier
  formatting + two real issues: an async method with no `await` and unsafe
  `any` member access in the new throttler guard, a floating promise in
  `main.ts`'s `bootstrap()` call) — `npx eslint src` is now fully clean.

**Verified live**: helmet CSP + security headers present on responses; CORS
preflight returns the right `Access-Control-Allow-*` headers for the
configured origin; 6 rapid login attempts → first 5 get `401` (wrong
password), 6th gets `429`; full CSRF round trip — login → fetch token from
`/auth/refresh/csrf-token` → `POST /auth/refresh` **without** the header
→ `403`, **with** the header → `200`; confirmed `/auth/login` and
`/auth/logout` are unaffected by the CSRF middleware (correctly scoped to
just `/auth/refresh`); `hpp` doesn't break ordinary requests; full Jest suite
(13 tests, 4 suites) still green.

## Milestone 7 — Protected route (`GET /users/me`) ✅ done

- `src/auth/decorators/public.decorator.ts` — `@Public()`, i.e.
  `SetMetadata(IS_PUBLIC_KEY, true)`.
- `src/auth/guards/jwt-auth.guard.ts` — `JwtAuthGuard`, registered as a
  **second global `APP_GUARD`** in `AppModule` after `ThrottlerGuard`
  (rate-limit before spending CPU on signature verification). Reads
  `@Public()` via `Reflector.getAllAndOverride`, parses the `Authorization`
  header, verifies through the Milestone 4 `ITokenService` token, and attaches
  `{ id, role }` to `request.user`. Every route is now protected unless it
  opts out — the inverse of Express's opt-in `requireAuth` default.
- `@Public()` applied to the only four routes that qualify: `GET /health`,
  `POST /auth/login` (no token exists yet), `POST /auth/refresh` +
  `GET /auth/refresh/csrf-token` + `POST /auth/logout` (authenticated by the
  refresh cookie instead).
- `src/auth/decorators/current-user.decorator.ts` — `@CurrentUser()` via
  `createParamDecorator`, so controllers never take `@Req()`.
- `src/auth/interfaces/authenticated-user.interface.ts` + `src/types/express.d.ts`
  — the request-attached shape, plus the declaration merge that teaches
  TypeScript `Express.Request` has a `user`.
- `src/users/users.service.ts` + `users.controller.ts` — `GET /users/me`.
  `UsersService.getProfile` **re-checks `deleted_at`/`is_active` on every
  call**: an access token stays valid for its full 15 minutes, so it outlives a
  soft delete or deactivation performed mid-window, and the token alone is not
  proof of a live account.
- `AuthModule` now `exports: [TOKEN_SERVICE]` — the global guard is
  constructed in `AppModule`'s context but verifies through `AuthModule`'s
  provider.

**Deliberately deferred, with reasons** (spec scope is unchanged — these move
to the step that first calls them, per YAGNI):
- `RolesGuard` + `@Roles()` — no head-teacher-only route exists yet; lands
  with the first one (Phase 1 users/curriculum CRUD).
- Repository-level branch/section scoping and the "teacher A cannot read
  section B" integration test (spec §9) — needs `sections`/`section_teachers`
  endpoints to scope and to test against.
- `branchId` in the JWT payload — only a scoping predicate; adding it now
  would mean touching `issueTokens` twice.
- Shared pagination / audit-interceptor / soft-delete / Arabic-normalisation
  utils — first callers are all in Phase 1–2.

**Verified live** (dev server booted clean, all modules resolving, `/users/me`
mapped): `/health` → `200` without a token · `/users/me` → `401 Missing
bearer token` without one · login → `/users/me` → `200` with the full public
profile and **no `password_hash`** · tampered token → `401 Invalid or expired
access token` · `Authorization: Basic <token>` → `401`. Jest 25 tests / 6
suites green (12 new across `jwt-auth.guard.spec.ts` and
`users.service.spec.ts`, covering the five Authorization-header boundary cases
and the deleted/deactivated/missing-account cases), `npx tsc --noEmit` clean,
`npx eslint src` clean.

## Milestone 8 / Phase 1 — Foundation ✅ done

Scope per spec §8 Phase 1, plus the authorization pieces deferred from
Milestone 7. Everything below is verified live against the Supabase DB by a
50-assertion smoke run (see "Verified live" at the end).

**Authorization (the pieces Milestone 7 deferred)**
- `src/auth/decorators/roles.decorator.ts` + `src/auth/guards/roles.guard.ts` —
  `@Roles('head_teacher')`, registered as a third global `APP_GUARD` after
  `JwtAuthGuard` (it needs `request.user`). A route with no `@Roles()` is open
  to any authenticated user, which is exactly the "both roles" rows of §3.
- `branchId` added to the JWT payload (`AccessTokenPayload`) — it is a scoping
  predicate on every branch-aware query, and the alternative is a user lookup
  on every request. `AuthService.issueTokens` now takes the `users` record
  instead of `(userId, role, ...)`, which kept it at three parameters.
- `src/common/branch-scope.ts` — `branchScope()` returns a Prisma
  where-fragment; `branch_id IS NULL` means institute-wide (§3).

**Shared infrastructure (each written with its first real caller)**
- `src/common/pagination.ts` — `PageQuerySchema` with a hard `MAX_PAGE_SIZE`
  of 100 (§9), `toPrismaPage`, `buildPage`.
- `src/common/audit.service.ts` + `common.module.ts` (`@Global`) — every
  mutation records `before`/`after`. Written as a **service, not an
  interceptor**: an interceptor sees request and response but never the row as
  it looked *before* the write, and `audit_logs.before` is what makes R8/R9
  reconstructable.
- `src/common/actor.decorator.ts` — `@CurrentActor()` gathers
  `{ userId, ipAddress, userAgent }` for the audit row without making services
  request-scoped.
- `src/common/prisma-exception.filter.ts` — maps P2002→409, P2003→409,
  P2025→404; anything unmapped falls through to the default 500 rather than
  being dressed up as a 4xx.
- `src/common/phone.ts` — `libphonenumber-js` region `EG` → E.164, **reject
  never coerce** (§9).
- `src/common/password.schema.ts` — the 72-byte bcrypt cap, extracted from
  `login.schema.ts` so user creation and login cannot drift apart.
- `src/common/arabic.ts` — `normalizeArabic()`: tashkeel, tatweel, ة→ه,
  أإآٱ→ا, ى→ي, ؤ→و, ئ→ي, Arabic-Indic digits, zero-width/bidi marks,
  whitespace (§6.2). First caller is subject aliases; the Excel import is the
  next one.
- `src/common/date-only.schema.ts` — `YYYY-MM-DD` → UTC midnight, rejecting
  impossible days that `new Date()` would silently roll forward.
- `src/common/hijri.ts` — `@umalqura/core` wrapper.

**Feature modules**
- `UsersModule` — full CRUD, head-teacher only, branch-scoped, soft delete
  with mandatory reason (R9), self-deletion refused.
- `ReferenceModule` — `GeographyController` (governorates, markazes,
  branches) and `CatalogueController` (levels, subjects, subject aliases,
  books). Reads open to both roles; writes head-teacher only. Creating a
  subject seeds its aliases through `normalizeArabic` automatically.
- `CalendarModule` — academic years and terms. `POST /academic-years` takes
  only `{ hijriYear }` and generates the whole calendar; any date can be
  overridden (§7.5).
- `CurriculumModule` — the year-scoped, self-nesting curriculum builder plus
  `curriculum_units`.
- `SettingsModule` — progression rules (R13/R17), attendance policies (§4.8),
  institute settings, and the audit-log read endpoint.

**Three bugs found and fixed while building, each worth remembering**
1. **The Hijri UTC off-by-one.** `@umalqura/core` builds its `.date` at
   *local* midnight, so in UTC+3 `umalqura(1447,10,15).date` is
   `2026-04-02T22:00:00Z` — which a Postgres `DATE` column truncates to
   2026-04-02 instead of the intended 2026-04-03. Every generated date now
   goes through `hijriToUtcDate()`, which rebuilds it with `Date.UTC`.
   Caught by writing the test before trusting the library.
2. **`upsert` cannot address the year-wide fallback rule.** `progression_rules`
   and `attendance_policies` are `UNIQUE (academic_year_id, level_id)` with a
   nullable `level_id`, and Postgres treats NULLs as *distinct* inside a
   unique index — so the `level_id IS NULL` fallback row (§4.3) is neither
   protected by that constraint nor reachable through Prisma's
   compound-unique `where` (which types `level_id` as non-null). A plain
   `upsert` would have inserted a second fallback row on every save. Replaced
   with `findFirst({ level_id: null })` (which compiles to `IS NULL`) then
   update-or-create. The smoke test asserts three consecutive saves still
   leave exactly one row.
3. **Arabic looked corrupted through curl on Windows.** `fullName` came back
   as U+FFFD replacement characters. Not an API bug — Git Bash mangles
   non-ASCII in a `-d` argument before curl ever sends it. Verified by
   re-testing through `node --eval` + `fetch`, where the round-trip is
   byte-identical. **Test Arabic payloads with node's fetch, never with a
   shell-quoted curl argument.**

**Verified live** — 50 assertions, all passing, against the real Supabase DB:
six levels seeded with R1/R15/R20 flags correct · alias normalisation
(`السيرة النبوية` → `السيره النبويه`) and its duplicate rejected with 409 ·
academic year 1447 generated as **2026-04-03 → 2027-01-23** with two terms and
exam windows, matching the unit tests exactly · three-level curriculum nesting
rejected (depth cap 2, §4.1) · a child under an *examinable* parent rejected
(parents are containers) · `passScore > maxScore` rejected (R18) · the
curriculum tree returning اللغة العربية with النحو and البلاغة nested under it,
scores as JSON numbers not Decimal objects · repeated NULL-level rule saves
leaving one row · `warnAtAbsences >= maxAbsences` rejected · the WhatsApp
access token absent from the settings response (§7.8) · 18 audit rows with
BigInt ids serialised as strings and the soft delete's `before` state intact ·
and, on every head-teacher-only route tried, **403 for the teacher account**.

Jest: 104 tests / 14 suites green. `npx tsc --noEmit` and `npx eslint src`
both clean.

**Still deferred, deliberately**: the `section_teachers`-based half of the
scoping layer and the "teacher A cannot read section B" integration test
(§9) — both need `sections` to exist, which is Phase 2.

## Phases 2–6 — the rest of the backend ✅ done

Spec §8 Phases 2, 3, 4, 5 and 6 (backend half). Nothing from the spec was cut.
Verified by 383 Jest tests plus six live smoke suites totalling **241
assertions** against the real Supabase database (`backend/test/smoke/`).

### The rules engine — pure functions, no Prisma, no Nest

Built before anything consumed it, because these are the calculations that
decide whether a real student progresses.

- `src/rules/scoring.ts` — §4.2 outcome resolution and the weighted term
  total. An absence contributes 0 to the numerator but keeps its weight in the
  denominator: otherwise skipping a paper would *raise* a percentage.
- `src/rules/promotion.ts` — §4.3, both rounds, transcribed from the
  pseudocode. **Two deliberate departures are documented in the file and
  flagged below.**
- `src/rules/comp-gate.ts` — §4.4 / R20.
- `src/rules/eligibility.ts` — §4.6, including carries reaching back a level.
- `src/rules/absence.ts` — §4.8 thresholds.

93 tests, including the §4.3 evidence table (1/2/3 failures → carry, 4+ →
repeat) and every R15/R17 boundary.

### Modules

`StudentsModule` · `SectionsModule` (sections + enrolments) ·
`ImportModule` (Excel in and out) · `TeachingModule` (timetable, sessions,
attendance) · `AssessmentModule` (exams, eligibility, scores, promotion,
certificates) · `MessagingModule` (templates, campaigns, WhatsApp, cron) ·
`ReportingModule`.

### Six real bugs found and fixed

1. **`CHECK (enrollment_id <> from_enrollment_id)` on `carried_subjects`.**
   A carry belongs to the enrolment that *carries it forward*, not the one it
   failed in — so §8 Phase 4's "confirm → next year's enrollments + carried
   subjects" is one indivisible step, and the promotion run had to create next
   year's enrolment before it had anywhere to attach the carry. The import path
   had the same bug; there, a carry with no forward enrolment is now counted
   and reported as deferred rather than invented or dropped.
2. **Postgres UNIQUE ignores NULLs — three tables.** `progression_rules`,
   `attendance_policies` and `exams`. The exam one was the worst: two
   identical shared-gender sittings would both insert, giving one paper two
   score grids and two sets of eligibility rows, silently. Full writeup in
   memory.md.
3. **A Buffer returned from a controller is JSON-encoded by Nest.** The Excel
   export sent `{"type":"Buffer","data":[...]}` under an `xlsx`
   Content-Type. Fixed with `StreamableFile`.
4. **Session invariants cannot be checked in a `.partial()` schema.** An
   omitted PATCH field is `undefined`, not `null`, so "an online session
   needs a meeting URL" passed validation and hit the DDL CHECK as a 500. Both
   invariants now check the *merged* row in the service.
5. **Subject-list splitting normalised before splitting**, so a multi-line
   cell (Alt+Enter — the real sheets use it) came back as one bogus subject.
   And error messages quoted the *normalised* token, sending the reviewer
   looking for text that is not in their file. Tokens are now split raw, kept
   raw, and de-duplicated on the normalised key.
6. **`groupBy` with `_count: { markaz_id: true }` counts non-null values**,
   so the "no markaz recorded" bucket — the largest one right after the
   historical import — reported zero.

### Two deliberate departures from the spec — both now settled

- **§4.3 post-makeup pass returns `promote` for a cleared terminal level.**
  Read literally, a student who cleared L4 in the makeup round would be
  "promoted" out of the final level, to nothing. The implementation graduates
  them instead. **Confirmed by the head teacher (2026-08-25):** COMP is
  elective and no student is obliged to take it, so finishing L4 *is*
  graduation — with or without COMP, and whichever round L4 was cleared in.
- **PREP still cannot carry after a makeup.** The second snippet omits the
  `allows_carry` guard the first one has. Unreachable in the current flow, but
  kept so R15 holds if the function is ever called directly.

### Spec items worth naming explicitly

- **§6.3 preview-then-commit** is real: `preview` writes only to
  `import_jobs`/`import_rows`, never to a domain table, and the smoke suite
  asserts that nothing exists until commit.
- **§9 "teacher A cannot read section B"** is enforced by `common/access-scope.ts`
  at the repository boundary and asserted live in b3/b4/b6/b7.
- **§7.7 no queue** — `message_campaigns` UNIQUE `(template, section, date)`
  and `job_runs` UNIQUE `(job_name, run_key)` claimed before work. `p-limit`
  was replaced by `src/common/concurrency.ts`: v7 is ESM-only and this is a
  CommonJS build, so the dependency would have cost more than the fifteen lines
  it saved.
- **§7.8 lead time** — the WhatsApp integration is inert until
  `WHATSAPP_ACCESS_TOKEN` and a phone number id exist. Sending refuses with a
  409 and leaves rows **queued**, not failed, so nothing has to be un-failed
  once Meta approval lands.
- **§9 PII** — `national_id` is AES-256-GCM encrypted (`common/field-encryption.ts`),
  read only through its own audited endpoint, and never present in a list
  response.

### Still open (unchanged from the spec's §10)

1. Curriculum `max_score`/`pass_score`/`weight` and the إلزامية flags need
   the head teacher — defaults of 100/50/1.0 are in place and mandatory flags
   start empty, which is what R17 requires.
2. Certificate text and layout. The API now **generates** a serial when one is
   not supplied (`L4-1447-0001`: level, Hijri year, sequence) and accepts any
   serial the institute prefers, so this no longer blocks issuing — only the
   printed wording is still open. `POST /certificates/:id/reprint` returns the
   facts a page needs; the layout belongs to whoever renders it.
3. `student_code` format. Generated as `YYYY-NNNN` until the institute says
   otherwise; supplying one explicitly always wins.

## Certificates — reprint and re-issue (2026-08-25, head teacher's request)

"Make it user friendly and it can be re-issued, so if a student loses it we can
re-issue it for him (just print it again)."

Two different things were tangled together, and they are now separate:

- **A lost or damaged paper** is not a new certificate. The achievement has not
  changed, so `POST /certificates/:id/reprint` reuses the existing row: same
  serial, same issue date, same issuing head teacher. It returns the facts a
  printed page is made of and records the copy in `audit_logs`, which is what
  lets the institute answer "how many copies of this exist" later. Reprinting a
  **revoked** certificate is refused.
- **A revoked certificate** does need a replacement. That was impossible:
  `UNIQUE (student_id, level_id)` counted revoked rows, so a certificate
  issued in error permanently consumed the student's only slot.

**Schema change** (applied to the live DB and to `schema-v1.1.sql`):

```sql
-- was: UNIQUE (student_id, level_id)
CREATE UNIQUE INDEX certificates_one_active_per_student_level
    ON certificates (student_id, level_id) WHERE revoked_at IS NULL;
```

One *live* certificate per student per level; revoked ones stay as history and
no longer block a replacement. Prisma cannot express a partial unique index, so
the `@@unique` was removed from `schema.prisma` by hand with a comment — the
same treatment as the `section_teachers` primary-teacher index.

Also made issuing user-friendly: a serial is **generated** when none is given
(`{LEVEL}-{HIJRI}-{NNNN}`, sortable and readable off the page), an explicit
serial always wins, and attempting to issue over a live certificate returns a
message naming the reprint action rather than a bare 409.

Verified by `test/smoke/cert-smoke.mjs` — 27 assertions, including that a
clean L4 graduates, that a reprint changes nothing but the copy count, that a
revoked certificate cannot be printed, and that a replacement gets a new serial
while the revoked one is kept.

**Not started: the frontend.** Every backend endpoint the spec's Phases 0–6
call for now exists — 115 routes.

## Security review remediation (2026-08-30, external white-box review)

A white-box source review (report.md) found the scope layer in `access-scope.ts`
was a convention, not a mechanism: `assessment` and `import` held branch-scoped
data behind routes any authenticated teacher could call. Fixed the confirmed
findings; `nest build`, `eslint`, `tsc` and the suite (**396 tests, 30 suites**,
up from 383) all green.

Authorization (the core of the report — F1–F4):

- **Assessment** (`exams`/`results`/`promotion` services + controller) now take a
  `viewer` and scope every read/write by branch. Create paths force `branch_id`
  to the viewer's branch (institute-wide head may still choose). New
  `assertExamVisible` / `loadVisibleExam` / `assertStudentVisible` mirror
  `StudentsService.findVisible`.
- **Import** routes are branch-scoped via `loadVisibleJob`. `POST /imports/:id/commit`
  **no longer takes a body** — branch, year and `isHistorical` are read from the
  persisted job, closing the commit-time parameter-tampering path (F3b). `fixRow`
  validates `matchStudentId` is in the job's branch (F3c).
- **Score/attendance grids** re-validate every child `enrollmentId` against the
  parent's eligible/active set — a correct section check was not enough on its
  own (F2).
- **Students** create/update pin `branch_id` so a teacher cannot create in, or
  move a student to, another branch (F4).
- Two new scope helpers, `canAccessBranch` / `resolveWritableBranch`, with unit
  tests. (The report's §1.1 "make it structurally un-bypassable" and §1.9 full
  route×role authorization matrix are noted as follow-ups, not done.)

Hardening:

- **Boot-time env validation** (`src/config/env.ts`): a missing/short
  `JWT_ACCESS_SECRET`, `CSRF_SECRET`, `FIELD_ENCRYPTION_KEY`, `DATABASE_URL` or
  (in prod) `CORS_ORIGIN` now aborts startup instead of 500-ing later (§1.3).
  Removed the `as string` casts in `jwt-token.service` / `csrf.ts`.
- **CORS** is a fail-closed comma-separated allowlist (F6). **Cookie `secure`**
  defaults on; local HTTP dev opts out with `COOKIE_SECURE=false` (F7).
- **JWT verify** pins algorithm/issuer/audience and parses the payload through a
  Zod schema before it reaches `request.user` (F8).
- **Login**: unknown user pays a dummy bcrypt compare; a locked account returns
  the same generic 401 as a wrong password (no timing/lockout enumeration, F9).
- **Password self-service**: `POST /users/me/password` (needs current password)
  and `POST /users/:id/password` (head-teacher reset); both revoke all refresh
  sessions (F10). Route count 115 → **117**.
- `whatsapp_phone_number_id` constrained to numeric (F11c); campaign listing
  branch-scoped (F11b); CSP adds `frame-ancestors`/`base-uri 'none'` (F11e).
- Extracted `auth/auth.constants.ts` (§1.5); typed `role` as `user_role_t`
  (§1.6); deleted `schema.prisma.bak` (§1.8).

**Schema change** — added `import_jobs.is_historical` to `prisma/schema.prisma`
(the source of truth) and ran `prisma generate`, so the client is current. There
is no migrations folder and `prisma db push` would fight the hand-managed partial
unique indexes, so apply the matching column to the live DB directly before
deploying (`schema-v1.1.sql` is the original bootstrap DDL and is not maintained):

```sql
ALTER TABLE import_jobs ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
```

**`db push` incident (same day).** The column was applied via `prisma db push`,
which added it correctly but **silently dropped both partial unique indexes**
Prisma can't represent (`certificates` one-live-per-student/level;
`section_teachers` one-primary-per-section). CHECK constraints survived. Both
indexes were recreated — no data violated them — and `npm run db:manual`
(`prisma/tools/manual-objects.sql`) now repairs them idempotently.

## Migration history introduced (2026-08-30)

Prompted by the `db push` incident: the database had no migration history at all,
so there was nothing to protect the objects Prisma cannot see.

- **Toolchain fixed first.** The CLI had been upgraded to `prisma@8.0.0-rc.12`
  while `@prisma/client` stayed at 7.10.0. Prisma 8 replaces everything with a
  "contract" system — no `generate`, no `migrate`, no `db execute` — and could
  not even read our `prisma.config.ts`. Pinned both back to **7.10.0**.
- **`prisma/migrations/0_init`** — a hand-assembled baseline: `migrate diff
  --from-empty --to-schema` output plus everything Prisma cannot emit
  (`pgcrypto`/`pg_trgm` extensions, all 28 CHECK constraints with their real
  names, and the 2 partial unique indexes).
- **Verified, not assumed.** Replayed the baseline into a throwaway schema inside
  a transaction and compared it to production: 39 tables, 104 FKs, 21 enums, 28
  CHECKs, 2 partial uniques — exact match — then rolled back. Docker wasn't
  running, hence the in-transaction approach.
- Baselined prod with `migrate resolve --applied 0_init`; `migrate status` reports
  "Database schema is up to date!".
- **Workflow scripts**: `db:migrate` (deploy), `db:migrate:status`, and
  `db:migrate:new -- <name>`. The last one diffs against the live DB because
  `migrate dev` needs a shadow database Supabase's pooler won't grant, and it
  **auto-strips the `DROP INDEX` statements** every diff emits for the two
  partial uniques — the exact footgun that caused the incident.
- `render.yaml` now runs `prisma migrate deploy` in the build command.
- Helper scripts live in **`prisma/tools/`** (renamed from `prisma/sql/`, which
  no longer described a folder holding two `.mjs` helpers).

## Build fix — `start:prod` was broken (2026-08-30)

Found while cleaning up stray `dist/` output. `tsconfig.build.json` set no
`rootDir`, so TypeScript inferred it from every included file; the root-level
`prisma.config.ts` pushed the common root to the project root and the entrypoint
landed at `dist/src/main.js`. Both `npm run start:prod` and `render.yaml`'s
`startCommand` run `node dist/main` — **a production boot would have failed
immediately.** Pinned `"rootDir": "./src"` and excluded `prisma` /
`prisma.config.ts`. Verified by booting the built bundle on a spare port and
getting `{"status":"ok"}` from `/health` with every route mapped.

That same exclusion stops `prisma/seed-head-teacher.ts` being compiled into the
production bundle — it was shipping the hardcoded `ChangeMe123!` default, and
nothing in `src/` imports it. Confirmed absent from `dist/` afterwards.

Deliberately deferred (documented in the summary): §1.1 structural enforcement,
§1.9 authz matrix e2e, F5 lockout-DoS redesign (needs new state), F2 composite
FKs and F10 `must_change_password` (need migrations), and the non-security
quality items (§1.2/1.4/1.7, global prefix, OpenAPI). The global prefix was
skipped on purpose — it would break the existing frontend and the `/auth/refresh`
CSRF-cookie path.

## Milestone 9 — Frontend scaffold — not started

## Milestone 10 — RTK Query — not started

