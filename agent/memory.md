# Memory — durable context & decisions

Running record of decisions and gotchas for this build. Not product code; read-only
reference for humans (and future Claude sessions working in this repo).

## Standing rule: keep `backend/docs/` current

The CV uploaded is the user's **current, updated** resume — its skill list is
the real baseline, not something to second-guess later. As new Nest/RTK
Query concepts get introduced each milestone, add them to
`backend/docs/nestjs-for-express-developers.md` (and its future frontend
counterpart) rather than letting the doc go stale. This is a standing
instruction, not a one-off request — apply it automatically every milestone
without being asked again.

## Learning material

`backend/docs/nestjs-for-express-developers.md` — a standalone NestJS
teaching doc, tailored to skip everything already covered by the CV
(REST/JWT/SOLID/Prisma/Jest) and focus only on Nest-specific concepts
(DI container, modules/providers, pipes/guards/interceptors/filters, custom
provider tokens, lifecycle hooks), each one cross-linked to where it already
appears in this repo. Not project history — a reference doc, updated
whenever a new Nest concept gets introduced in a later milestone.

## Who this is for

Ahmed Mostafa ElKashif, backend developer. Already fluent in Node.js/Express,
PostgreSQL, Prisma ORM, JWT, RBAC, MVC/3-layer architecture, SOLID principles (see
CV: ITIER Study Tracker, BIOSELVA platform — both Node/Express/PostgreSQL/Prisma).
**First time with NestJS and RTK Query specifically.** Explanations in this build
skip REST/JWT/SOLID/ORM basics and focus on what Nest and RTK Query do differently
from the Express/plain-Redux patterns he already knows.

## Locked-in decisions

- Two independent top-level folders: `backend/` (NestJS) and `frontend/`
  (React+Vite), each with its own `package.json`. No root npm workspace. Shared
  zod schemas are duplicated between the two for now — revisit if it becomes
  painful.
- Login identifier is a new `username` field on `users` (not phone/email).
  Head-teacher account created directly (seed script / one-off admin action);
  teachers register later. OTP-based password reset via phone/email is a
  *future* feature, not Phase 0.
- Password hashing: bcrypt, cost 12.
- Refresh tokens: opaque random value, hashed at rest with **SHA-256** (not
  bcrypt — bcrypt's cost factor is for slow-hashing low-entropy secrets like
  passwords; a refresh token is already high-entropy, so a fast cryptographic
  hash is the right tool and doesn't add pointless latency to every refresh
  call).
- Database: Supabase project created by the user. Full credential set (DB
  pooler/direct URLs, project URL, anon key, service-role key, storage bucket)
  captured in `.env.example` in one pass rather than piecemeal per phase.
- Prisma strategy: `schema-v1.1.sql` is the source of truth. Apply the raw DDL
  to the live DB first, then `prisma db pull` to generate `schema.prisma` —
  never hand-translate the DDL's composite FKs/partial indexes into Prisma DSL
  by hand (drift risk).
- Lockout policy (Milestone 5, not in the spec verbatim — a reasonable
  default chosen during implementation): 5 failed logins locks the account
  for 15 minutes (`MAX_FAILED_LOGINS`/`LOCKOUT_DURATION_MS` in
  `auth.service.ts`). `failed_logins` resets to 0 on any successful login.
  Revisit these constants if the head teacher wants different numbers —
  they're not derived from the spec, just a sane starting point.
- A `head_teacher` test account exists in the live DB
  (`prisma/seed-head-teacher.ts`, username `headteacher`) purely for
  verifying the auth flow — **not the institute's actual head-teacher
  account**. Replace/update before this goes anywhere real.

## Hosting: Render

- **Architecture locked in: two separate git repos, two Render services, one
  Render Project.** `backend/` → its own repo → Render **Web Service**
  ($7/mo Starter — needs an always-on process for Nest + the Thursday WhatsApp
  cron). `frontend/` → its own repo → Render **Static Site** (free, no running
  process). Considered and rejected: single-origin (Nest serving the built
  frontend from one service) — incompatible with the two-repo split the user
  explicitly chose.
  Consequence: `backend/` and `frontend/` are no longer just sibling folders
  for convenience — each needs its own `git init` (not yet done as of this
  note) before the first Render deploy. Currently both still live under the
  same local working directory with no git repo at any level yet.
- Reuses the `/health` route (Milestone 1) as Render's health-check path for
  the backend Web Service.
- **Cross-site cookie drop — now handled via `COOKIE_SAMESITE` (frontend F0d).**
  Render's default `*.onrender.com` domains are on the Public Suffix List, so
  two separate services are cross-site and a `SameSite=Strict` refresh cookie is
  silently dropped once deployed, even though it works fine in local dev. The
  refresh and CSRF cookies now both read `COOKIE_SAMESITE` through one helper
  (`src/auth/cookie-security.ts`): default `strict`; set `none` for a cross-site
  deploy (forces `Secure`; CSRF is unaffected — `csrf-csrf` binds to the cookie
  hash, not `SameSite`). `backend/render.yaml` sets `none`. The alternative is a
  custom domain under one registrable root, which keeps `strict`. Decision table
  and runbook in the frontend repo's `DEPLOY.md`; spec §7.10.
- Backend `CORS_ORIGIN` must be set to the frontend's actual Render URL (or
  custom domain) — genuine cross-origin `fetch` now, not same-origin.
- Env vars in production come from Render's dashboard/Environment Groups, not
  a committed file. Each repo's `.env.example` documents the shape for local
  dev only.

## Env / gitignore

- `backend/.env` populated by the user directly with real Supabase +
  auth secrets (not shared in chat). Actual key names used (note: Supabase's
  newer naming, not the older `ANON_KEY`/`SERVICE_ROLE_KEY`):
  `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `JWT_ACCESS_SECRET`,
  `REFRESH_TOKEN_PEPPER`, `CSRF_SECRET`, `CORS_ORIGIN`, `PORT`.
- `backend/.env.example` created to mirror that shape with empty values.
- `.gitignore` kept **per folder**, not a shared root one — `backend/.gitignore`
  created (project isn't a git repo yet) covering `node_modules/`, `.env*`
  (except `.env.example`), `dist/`/`build/`, logs, OS/editor junk, scoped to
  `backend/` only. `frontend/.gitignore` follows the same pattern once
  `frontend/` is scaffolded (Milestone 8).

## Schema change made

`schema-v1.1.sql` — added `username TEXT NOT NULL UNIQUE` to `users`, right
after `full_name`.

## Prisma 7 CLI config

Prisma 7 moved CLI-level configuration (used by `db execute`, migrations, etc.)
out of `schema.prisma` and into a separate `prisma.config.ts` at the `backend/`
root — `schema.prisma`'s own `datasource` block (with `env("DATABASE_URL")`/
`env("DIRECT_URL")`) is still what the generated `PrismaClient` uses at
runtime, but the CLI now reads `prisma.config.ts`'s `datasource.url`
independently, and does **not** auto-load `.env` for that file — had to
explicitly `import { config as loadEnv } from 'dotenv'; loadEnv();` at the top.
`prisma.config.ts` currently points `datasource.url` at `DIRECT_URL` (correct
for migrations/`db execute`; the running app still uses the pooler via
`DATABASE_URL` in `schema.prisma`).

## ⚠️ NestJS does not auto-load `.env` — the biggest gotcha so far

`main.ts` never called `dotenv.config()`. Neither did `PrismaService`,
`AuthController`, or anything else in the actual running app — only
`prisma.config.ts` (Prisma CLI) and standalone scripts (seed script,
diagnostics) ever loaded it, because *they* explicitly did. This meant
`process.env.DATABASE_URL` (and every other env var) was `undefined` at
runtime for the real app the entire time across Milestones 2–5, and
`PrismaService` was silently falling back to `pg`'s default local-connection
behavior. Every `.env` edit made during that window had **zero effect** on
the running app — which is exactly why the login endpoint kept failing with
the same generic `ECONNREFUSED` no matter what got changed in `.env`, right
up until this was found.

**Fixed** by adding `import 'dotenv/config';` as the literal first line of
`main.ts` (must run before `AppModule`/`PrismaService` are constructed, since
that's when `process.env.DATABASE_URL` first gets read) and installing
`dotenv` as an explicit dependency (`npm install dotenv` — it was only ever
a transitive one before, which is fragile to depend on silently).

**Lesson for next time a "nothing I change seems to matter" bug shows up**:
check whether the value is actually reaching `process.env` in the running
process before assuming the fix itself is wrong — Prisma's own error
wrapping (see below) made this much harder to diagnose than it should have
been, because it reported the exact same generic error for three unrelated
root causes in a row.

## Prisma's driver-adapter errors are dangerously generic

Every connection-time failure through `@prisma/adapter-pg` — wrong
credentials, wrong SSL mode, or `DATABASE_URL` being entirely `undefined` —
surfaces identically as `PrismaClientKnownRequestError` with
`code: 'ECONNREFUSED'` and no further detail (no host, no port, no original
message). This is a real regression from Prisma's pre-driver-adapter error
messages, which used to include much more. **When this generic error shows
up, don't trust it — bypass Prisma entirely** with a throwaway script using
`pg.Pool` directly against the same connection string; it surfaces the real
underlying error (this is exactly how the `self-signed certificate in
certificate chain` issue below was actually found, on the second real bug
after the `.env`-loading one).

## Supabase pooler + `sslmode=require` fails with newer `pg`

Once `.env` was actually loading, `sslmode=require` in `DATABASE_URL`/
`DIRECT_URL` still failed with `self-signed certificate in certificate
chain` (`SELF_SIGNED_CERT_IN_CHAIN`) — newer `pg-connection-string` versions
treat `require`/`prefer`/`verify-ca` as aliases for `verify-full` (full CA
chain validation), and Supabase's pooler cert doesn't fully validate against
Node's default trust store from this network. **Fixed** by using
`sslmode=no-verify` instead — encrypts the connection without CA validation,
which is the normal/expected mode for connecting to a managed Postgres
pooler like this. Applied to both `DATABASE_URL` and `DIRECT_URL`.

## CSRF token endpoint path — why it lives under `/auth/refresh`

`csrf-csrf` v4 requires a `getSessionIdentifier` — normally a server session
id, which this stateless-JWT app doesn't have. Bound it instead to a SHA-256
hash of the caller's `refresh_token` cookie. That only works if the cookie
is actually present when the CSRF token is issued — and the refresh cookie
is scoped to `Path=/auth/refresh`, so a token-issuance endpoint anywhere
else (e.g. a top-level `/auth/csrf-token`) would never see it. Solved by
putting the endpoint at `GET /auth/refresh/csrf-token` — a subpath of
`/auth/refresh`, which cookie path-scoping treats as covered.

## Layered rate limiting on `/auth/login`

Both the global `ThrottlerGuard` (IP-only, `APP_GUARD` in `AppModule`) and
the route-specific `LoginThrottlerGuard` (IP+username) check the **same**
`'default'` throttler name, so `@Throttle({ default: { limit: 5, ttl:
60_000 } })` on the login route overrides the limit for *both* guards
simultaneously on that route — even though they track different keys. This
is intentional layering, not a bug: the IP-only counter catches raw volume
from one IP regardless of username, the IP+username counter specifically
catches the "vary the username to dodge IP throttling" bypass the spec
calls out. Side effect worth remembering while testing: hammering the login
route with *any* usernames from one IP exhausts the IP-only counter too, so
a subsequent legit login from that same IP/machine will also get `429` until
the window resets — this cost a test cycle (see progress.md) before being
understood as expected behavior, not a bug.

## Testing Arabic payloads: use node's fetch, never shell-quoted curl

A `curl -d '{"fullName":"سارة محمد"}'` from Git Bash on Windows arrives at the
API as U+FFFD replacement characters — the shell mangles non-ASCII in the
argument before curl sends it. This looked exactly like an encoding bug in the
API and cost a diagnostic cycle in Phase 1. The API is fine: the same payload
sent via `node --eval` with `fetch` round-trips byte-identically. Any future
smoke test involving Arabic goes through a `.mjs` script, not a shell heredoc.

## @umalqura/core builds dates at LOCAL midnight — a real off-by-one

`umalqura(1447, 10, 15).date` is `2026-04-02T22:00:00Z` in UTC+3, i.e. local
midnight on 2026-04-03. Handing that straight to Prisma for a Postgres `DATE`
column stores **2026-04-02**, one day early — silently, and on every generated
session and exam date. `src/common/hijri.ts` rebuilds every conversion with
`Date.UTC(...)` and `hijri.spec.ts` asserts the UTC calendar day specifically
(asserting the timestamp would pass in UTC and fail in Cairo). Same class of
bug on the way in: `DateOnlySchema` only accepts `YYYY-MM-DD` and rejects a
zoned timestamp, so a client in Cairo cannot send `2026-04-03T00:00+03:00` and
have it stored as the 2nd.

## Schema changes made to `schema-v1.1.sql` after it was "final"

Two, both applied to the live Supabase DB and to the source DDL:

1. **`users.username`** — added during Phase 0 (see "Schema change made" below).
2. **`certificates`: plain UNIQUE → partial unique index** (2026-08-25).
   `UNIQUE (student_id, level_id)` counted revoked rows, so a certificate
   issued in error permanently consumed a student's only slot and could never
   be replaced. Now:
   ```sql
   CREATE UNIQUE INDEX certificates_one_active_per_student_level
       ON certificates (student_id, level_id) WHERE revoked_at IS NULL;
   ```
   Prisma cannot express a partial unique index, so the `@@unique` was removed
   from `schema.prisma` by hand with a comment — third instance of that
   pattern, after `section_teachers` and this one's cousin below.

   **`prisma db execute` hung** applying it (no output, timed out at 4
   minutes). The documented workaround below — a throwaway `pg.Client` script
   against `DIRECT_URL` — worked immediately and printed the before/after
   constraint list. Reach for that first for any future DDL change.

## Postgres UNIQUE treats NULLs as distinct — THREE tables hit by this

This is not a one-off. Every unique key in `schema-v1.1.sql` that contains a
nullable column is unenforced for the NULL case, and in each one the NULL
carries real meaning:

| Table | Key | NULL means |
|---|---|---|
| `progression_rules` | `(academic_year_id, level_id)` | the year's fallback rule (§4.3) |
| `attendance_policies` | `(academic_year_id, level_id)` | the year-wide policy (§4.8) |
| `exams` | `(branch_id, term_id, curriculum_id, gender, exam_type)` | a shared sitting for both genders (R3) |

Two consequences each time: the index does **not** prevent duplicates, and
Prisma's generated compound-unique `where` types the column as non-null, so
`upsert` can never match the NULL row and inserts another one.

The duplicate exam was the worst of the three — two exams for one paper means
two score grids and two sets of eligibility rows, and nothing would have
complained. Caught only because the smoke test asserted the duplicate was
refused.

**The fix in all three: `findFirst` with the nullable column set to `null`**
(which Prisma does compile to `IS NULL`), then update-or-create / reject.
**Before adding any new unique key containing a nullable column, either make
the column NOT NULL with a sentinel, or write the guard.**

### The original writeup (progression_rules / attendance_policies)

`progression_rules` and `attendance_policies` are `UNIQUE (academic_year_id,
level_id)` where `level_id IS NULL` means "the year's fallback rule" (§4.3).
Two consequences, both bit us: the unique index does **not** prevent duplicate
NULL rows, and Prisma's generated compound-unique `where` types `level_id` as
non-null, so `upsert` can never match the fallback row and inserts a new one
every save. Fixed with `findFirst({ where: { level_id: null } })` — which does
compile to `IS NULL` — followed by update-or-create. **Any other table with a
nullable column in a unique key needs the same treatment.** The read-then-write
is non-atomic; acceptable for a one-person settings screen, not for anything
concurrent.

## Gotchas hit during setup

- **`npx @nestjs/cli new backend` failed with `ECOMPROMISED` / "Lock
  compromised"** on Windows. Root cause: npm's `libnpmexec` lock-watchdog
  (`with-lock.js`) aborts if it can't "touch" its lock file often enough —
  happens on Windows when disk/AV latency stalls a large dependency install
  mid-flight. Not a project bug, not retry-worthy as-is.
  **Fix:** install the CLI globally once (`npm install -g @nestjs/cli`) and
  invoke the bare `nest` command directly instead of going through `npx` every
  time.
- **Piping a long-running `npm run start:dev` through `| head -N` in
  Git Bash on Windows produced zero output**, even after 30+ seconds, because
  Node's stdout buffers fully when piped to a non-TTY consumer that hasn't
  exited — `head` never got a flush. **Fix:** run the dev server unpiped in
  the background and read its raw output file directly.
- **`prisma db execute` fails with `P1000` (bad credentials for `postgres`)**
  against both `DATABASE_URL` and `DIRECT_URL`, confirmed by swapping
  `prisma.config.ts` between the two — both fail identically, isolating the
  problem to the password value itself (host/port/username structure checked
  fine via Node's `URL` parser, not a copy-paste-into-wrong-field mistake).
  Follow-up diagnostic (before the fix) confirmed the connection string was
  always well-formed — no unencoded reserved characters, quotes stripped
  correctly by dotenv — so it was never an encoding problem, just a stale/
  wrong password. **Resolved**: user reset the DB password in Supabase and
  updated `backend/.env`; `db execute` then succeeded immediately.

## Prisma 7 introspection gotchas (`section_teachers`)

`npx prisma db pull` on the live DB surfaced two real Prisma-7-specific
representation bugs, neither of which reflect an actual data-model problem —
both fixed by hand-editing the generated `schema.prisma`, DB left untouched:

1. **Partial unique index broke relation-cardinality inference.** The DDL has
   `CREATE UNIQUE INDEX ON section_teachers (section_id) WHERE is_primary`.
   Introspection represented it as `section_id String @unique(where:
   raw("is_primary"))` on the scalar field — but Prisma's relation validator
   then treated `section_id` as *fully* unique (ignoring the `where` clause),
   which broke the separate composite-FK relation `(section_id, gender) →
   sections(id, gender)` sharing that column. **Fix:** removed the `@unique`
   annotation from the scalar field entirely (left a comment explaining why).
   The partial index still exists and is enforced in Postgres — Prisma
   Client just doesn't model it, exactly the tradeoff the plan anticipated
   for constructs Prisma can't fully express.
2. **Back-relations on `sections` introspected as singular instead of list.**
   `section_teachers` has *two* separate FKs to `sections` (one plain on
   `section_id`, one composite on `(section_id, gender)` for the gender-
   segregation guarantee). Both are genuinely many-to-one (many teachers per
   section), but introspection generated singular optional back-relation
   fields (`section_teachers?`) on the `sections` model for both — while the
   equivalent pair of relations to `users` correctly came out as arrays
   (`section_teachers[]`). This is an introspection bug specific to this
   "two composite FKs sharing a column, targeting the same table" shape, not
   an intentional 1:1. **Fix:** manually changed both fields on `sections`
   from `section_teachers?` to `section_teachers[]`.

General lesson: when Prisma's own generated schema disagrees with what the
DDL actually means, **fix the Prisma representation, never the database** —
the DDL in `schema-v1.1.sql` is the source of truth (per the plan's Prisma
strategy).

## Prisma 7 datasource model (no more `url` in schema.prisma)

Beyond the CLI-config split noted above, Prisma 7 also removed `url`/
`directUrl` from the `datasource` block in `schema.prisma` entirely — the
generated `PrismaClient` now requires a **driver adapter** passed to its
constructor at runtime. Installed `@prisma/adapter-pg` + `pg`; `PrismaService`
(`src/prisma/prisma.service.ts`) builds `new PrismaPg(process.env.DATABASE_URL)`
and passes it as `{ adapter }` to `super()`. `schema.prisma`'s datasource block
is now just `provider = "postgresql"` — no connection info at all.

## Security review remediation — gotchas (2026-08-30)

The external white-box review (report.md) drove a round of fixes. Things that
will bite a future session if forgotten (full log in progress.md):

- **Env is validated at boot** (`src/config/env.ts`, called first in
  `main.ts`). The process now *refuses to start* if `JWT_ACCESS_SECRET` (<32
  chars), `CSRF_SECRET` (<16), `FIELD_ENCRYPTION_KEY`, `DATABASE_URL`, or — in
  production — `CORS_ORIGIN` is missing. If the app won't boot after an env
  change, read the single aggregated error it prints; it names every offending
  var. Unit tests set these directly and never call `validateEnv()`, so a
  28-char test secret is fine in specs.

- **Cookie `secure` now defaults ON** (`cookie-security.ts`, was gated on
  `NODE_ENV==='production'`). For **local HTTP dev you must set
  `COOKIE_SECURE=false`** or the browser silently drops the refresh cookie and
  every refresh fails — the same failure shape as the `COOKIE_SAMESITE` gotcha.
  `COOKIE_SAMESITE=none` still forces secure on regardless.

- **`import_jobs.is_historical` is a new column** (in `prisma/schema.prisma` +
  generated client). `POST /imports/:id/commit` now takes **no body** —
  branch/year/isHistorical come from the persisted job.

- **⚠️ `prisma db push` DROPS the partial unique indexes — never run it on this
  DB.** On 2026-08-30 a `db push` (to add `is_historical`) succeeded but
  *silently dropped* both partial unique indexes, because Prisma can't represent
  them so it reconciled them out of existence:
  `certificates (student_id, level_id) WHERE revoked_at IS NULL` (one live
  certificate per student/level) and `section_teachers (section_id) WHERE
  is_primary` (one primary teacher per section). CHECK constraints survived (28
  of them) — `db push` leaves those alone; only indexes get reconciled. Both were
  recreated, and `npm run db:manual` (`prisma/tools/manual-objects.sql`) repairs
  them idempotently if it ever happens again.

- **The database now has a real migration history** (`prisma/migrations/`),
  added 2026-08-30 in response to that incident. `0_init` is a hand-assembled
  baseline: `migrate diff --from-empty --to-schema` output, plus the things
  Prisma cannot emit — `CREATE EXTENSION pgcrypto/pg_trgm`, all 28 CHECK
  constraints (real names, from `pg_get_constraintdef`), and the 2 partial unique
  indexes. It was **verified** by replaying it into a throwaway schema inside a
  transaction and diffing the result against production (39 tables / 104 FKs /
  21 enums / 28 checks / 2 partial uniques — exact match), then rolling back.
  Marked applied on prod via `migrate resolve --applied 0_init`, so it only runs
  on a fresh DB.
  - Workflow: `npm run db:migrate:new -- <name>` → review → `npm run db:migrate`.
  - **`migrate dev` is unusable here** — it wants a shadow database the Supabase
    pooler won't grant. That's why `db:migrate:new` diffs against the live DB
    instead. Never run `migrate dev`/`migrate reset` against prod (reset drops
    all data).
  - **Every diff reports the 2 partial uniques as drift and emits `DROP INDEX`
    for them.** `prisma/tools/new-migration.mjs` strips those automatically and
    prints that it did. If you hand-write a migration, never re-add them.
  - `schema-v1.1.sql` is the original bootstrap DDL, superseded by `0_init` and
    no longer maintained.

- **`npm run start:prod` was silently broken until 2026-08-30 — and so was the
  Render deploy.** `tsconfig.build.json` set no `rootDir`, so TypeScript inferred
  it from every included file; the root-level `prisma.config.ts` dragged the
  common root up to the project root and the entrypoint was emitted at
  `dist/src/main.js`. But `start:prod` (and `render.yaml`'s `startCommand`) run
  `node dist/main`, which did not exist — a production boot would have failed
  immediately. Fixed by pinning `"rootDir": "./src"` and excluding `prisma` and
  `prisma.config.ts` from the build. Verified by actually booting
  `node dist/main.js` on a spare port and hitting `/health`.
  - Side effect: with `rootDir` set, the incremental cache moved from
    `dist/tsconfig.build.tsbuildinfo` to the project root. It is now gitignored
    (`*.tsbuildinfo`). If a build ever emits *nothing* while exiting 0, delete
    that file — a stale one makes tsc think everything is up to date.
  - The same exclusion stops `prisma/seed-head-teacher.ts` compiling into the
    bundle, which had been shipping the hardcoded `ChangeMe123!` default into
    production. Nothing in `src/` imports the seed; it is a one-off admin script.

- **Prisma CLI 8.x is NOT usable on this project.** Following the CLI's own
  update notice upgraded `prisma` to `8.0.0-rc.12` while `@prisma/client` stayed
  on 7.10.0. v8 replaced the whole surface with a "contract" system — no
  `generate`, no `db execute`, no `migrate` — and its `contract emit` cannot even
  read this repo's `prisma.config.ts`. Symptom: `No command registered for
  'generate'`. **Fix: keep `prisma` and `@prisma/client` pinned to matching 7.x**
  (currently both 7.10.0). Do not accept the 8.x update prompt.

- **JWT verify pins `algorithms: ['HS256']`, issuer and audience** and Zod-parses
  the payload (`jwt-token.service.ts`, constants in `auth/auth.constants.ts`).
  Any test that hand-signs a token with `JwtService.sign` must pass the same
  `issuer`/`audience`/`algorithm` or verify will reject it.

- **`viewer` is threaded through assessment + import services.** When adding a
  new method there, take `viewer: AuthenticatedUser` and scope by branch via
  `branchScope` / `canAccessBranch` / `resolveWritableBranch` — the review found
  the whole failure class was "a service that skipped the scope layer".

## A UNIQUE is a CONSTRAINT here, not an INDEX — `DROP INDEX` fails (2026-09-10)

`prisma migrate deploy` failed applying `20260910000000_sections_one_per_level_gender`:

```
ERROR: cannot drop index sections_branch_id_academic_year_id_level_id_gender_name_key
because constraint ... requires it            (SQLSTATE 2BP01)
HINT: You can drop constraint ... instead.
```

**Why.** `prisma/migrations/0_init/migration.sql` declares these keys as
`CREATE UNIQUE INDEX`, and a `migrate diff` will happily generate a matching
`DROP INDEX`. But the live database was built from **`schema-v1.1.sql`**, which
declares them inline on the table — so in Postgres they are constraints
(`pg_constraint.contype = 'u'`) with a dependent index that cannot be dropped on
its own.

**Rule.** When a migration touches a UNIQUE on a table that came from
`schema-v1.1.sql`, check the database before trusting the generated SQL:

```sql
SELECT conname, contype FROM pg_constraint WHERE conname LIKE 'sections_%';
```

`contype = 'u'` → use `ALTER TABLE ... DROP CONSTRAINT` / `ADD CONSTRAINT ... UNIQUE`,
not `DROP INDEX` / `CREATE UNIQUE INDEX`. The migration history and the database
disagree about how these were created; the database wins.

**Recovering a half-applied migration.** The failure was on the first statement,
so nothing was applied — `prisma migrate resolve --rolled-back <name>` clears the
failed row, then fix the SQL and re-run `npm run db:migrate`. Check
`_prisma_migrations.finished_at IS NULL` to confirm it never completed before
resolving as rolled back.
