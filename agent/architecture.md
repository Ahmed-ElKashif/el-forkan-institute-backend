# Architecture — module map & why

Living document. Each structural choice is tied to the SOLID/Clean-Code
principle it serves — the point isn't the pattern for its own sake, it's being
able to say *why* each piece is shaped the way it is.

## Current module map (as of Milestone 2)

```
AppModule
├─ AppController   — HTTP layer only: routes GET /health, delegates
├─ AppService      — business logic: builds the health payload
└─ PrismaModule (@Global)
   └─ PrismaService — extends PrismaClient, owns connection lifecycle
```

**Why split Controller/Service at all, even for something this trivial?**
Single Responsibility: the controller's only job is translating HTTP in and
out (route, status code, response shape). The moment `/health` needs to check
a real dependency (DB reachability, disk space, whatever), that logic grows
inside `AppService` without ever touching `AppController`. If we'd inlined the
logic into the controller, every future change to *what* health means would
also be a change to *how HTTP works*, which is exactly the kind of coupling
Separation of Concerns exists to prevent.

**Why `@Injectable()` on the service instead of just importing a plain
object/function?**
This is what makes the service a *provider* Nest's DI container can construct
and hand to anything that asks for it in a constructor. It's also what makes
Dependency Inversion possible later: `AuthService` won't depend on a concrete
`BcryptPasswordHasher`, it'll depend on an `IPasswordHasher` interface, and
Nest's container will be the thing that decides which concrete implementation
to inject — see Milestone 4 once we get there.

## `PrismaModule` / `PrismaService` (Milestone 2)

`PrismaService` (`src/prisma/prisma.service.ts`) extends `PrismaClient`
directly and implements `OnModuleInit`/`OnModuleDestroy` — Nest lifecycle
hooks, not a Prisma concept. `onModuleInit` calls `this.$connect()`,
`onModuleDestroy` calls `this.$disconnect()`.

**Why hook into Nest's lifecycle instead of just constructing `PrismaClient`
at module load time?** Two reasons: (1) it makes connection setup/teardown
*part of Nest's own boot sequence* — if the DB is unreachable, the app fails
to start with a clear error at boot, not on some unlucky first request; (2)
it's what makes this swappable/mockable in tests — a test module can provide
a different `PrismaService` (or a mock) without anything in `AppModule`'s
shape changing, because Nest is resolving `PrismaService` through DI, not
through a hardcoded import of a constructed client.

**Why `@Global()` on `PrismaModule`?** Nest module scoping is opt-in by
default — a provider is only visible to modules that explicitly `imports:
[PrismaModule]`. Almost every future feature module (`UsersModule`,
`AuthModule`, `StudentsModule`, …) will need `PrismaService`. `@Global()`
means it only needs importing once (here, in `AppModule`), and every other
module can inject `PrismaService` without repeating that import — appropriate
for a true cross-cutting infrastructure concern like a DB connection, but not
a pattern to reach for casually (most modules should NOT be global; doing so
for everything would erase the whole point of module boundaries).

**Why does `PrismaService`'s constructor build a `PrismaPg` adapter instead
of a plain connection string?** Prisma 7 moved to a "driver adapter" model —
`schema.prisma` no longer carries connection info at all (`datasource db {
provider = "postgresql" }`, nothing else). The generated `PrismaClient`
requires an adapter object at construction time; `@prisma/adapter-pg`'s
`PrismaPg` wraps a real `pg.Pool` under the hood. This is a Prisma-version
detail, not a design choice we made for its own sake.

## `IPasswordHasher` / `ITokenService` — Dependency Inversion for real (Milestone 4)

```
AuthModule
├─ providers: { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher }
│             { provide: TOKEN_SERVICE,   useClass: JwtTokenService }
├─ imports:   JwtModule.register({}), UsersModule
UsersModule
└─ providers: UsersRepository (exported)
```

Neither interface has an implementation baked into its name — `AuthService`
(Milestone 5) will declare `@Inject(PASSWORD_HASHER) private hasher:
IPasswordHasher` in its constructor. It never imports `bcrypt` or knows the
word "bcrypt" exists. The **only** place that decision is made is the single
`useClass` line in `auth.module.ts`. This is Dependency Inversion exactly as
you already know it from SOLID — Nest's DI token system (a `Symbol` used as
the `provide` key, since two different classes could otherwise want to
register under the same string) is just the *mechanism* Nest gives you to
express it, rather than a factory function you'd write by hand in Express.

Concretely, this is what makes "argon2id is stronger if you'd rather swap"
(spec §7.3) a one-line change later: swap `useClass: BcryptPasswordHasher`
for `useClass: Argon2PasswordHasher`, and nothing else in the codebase
changes, because nothing else ever depended on bcrypt specifically.

**Why `UsersRepository` as a plain class, not behind another interface?**
Nest already lets you inject `UsersRepository` by its class type as the
token — no separate interface needed unless you actually expect multiple
real implementations (we don't; there's one Postgres database). The
interface pattern above is reserved for `IPasswordHasher`/`ITokenService`
specifically because those *do* have multiple realistic implementations
(bcrypt vs argon2id, JWT vs some other scheme) — introducing an interface
"just in case" for `UsersRepository` would be the premature abstraction the
project's own conventions warn against.

**Why does `JwtTokenService` handle both access-token signing *and*
refresh-token generation/hashing, instead of splitting into two providers?**
Single Responsibility is about one *reason to change*, not one method per
class — both concerns here are "produce and validate a token," and they
share the same secret-management/crypto surface. Splitting further would be
ceremony without a real axis of variation (nothing suggests JWT signing and
refresh-token hashing will ever need to vary independently). Compare this to
`IPasswordHasher` vs `ITokenService` staying separate: those genuinely do
vary independently (you could swap one without the other).

## `AuthService`/`AuthController` (Milestone 5)

```
AuthController        — HTTP only: routes, status codes, cookie get/set
  └─ AuthService       — orchestration: login/refresh/logout business logic
       ├─ UsersRepository        (Milestone 4; findByEmail is the login identity)
       ├─ OtpService             (F12 — email second factor, see below)
       ├─ IPasswordHasher token  (Milestone 4)
       ├─ ITokenService token    (Milestone 4)
       ├─ IEmailSender (EMAIL_SENDER) — Resend, F12; bound in AuthModule, not
       │                                CryptoModule (login-only, not shared)
       └─ PrismaService          (Milestone 2, for refresh_tokens directly —
                                   no separate repository for that table yet,
                                   see below)
```

**Two-factor login (F12).** Staff sign in with **email + password**, then a
six-digit code emailed via Resend. `POST /auth/login` verifies the password and
returns `{ mfaRequired, challengeId }` — **no tokens, no cookie**. `POST
/auth/verify-otp` exchanges `{ challengeId, code }` for the session (this is the
step that sets the refresh cookie). A stolen password alone therefore opens
nothing. `OtpService` owns the `otp_challenges` lifecycle end to end (mint →
hash with the bcrypt hasher → verify under a 5-minute TTL and a 5-attempt cap);
the raw code is never stored, only its hash. `RESEND_API_KEY` / `OTP_EMAIL_FROM`
live in env, never the database (mirrors the WhatsApp token); with them unset in
non-production the code is logged to the console instead of emailed, so login is
testable before a sending domain exists — production fails closed.

**Same OTP, second use — password reset.** `POST /auth/password-reset/request`
(email → a `password_reset` OTP, always 200 + a challenge id whether or not the
email exists, so no enumeration) and `POST /auth/password-reset/confirm`
(`{ challengeId, code, newPassword }` → new hash + **all refresh tokens
revoked**). The `otp_challenges.purpose` column is the guard that a reset code
— issued on email alone, no password — can never satisfy a login: `verify` is
scoped to the purpose the challenge was minted for.

**Email is required on user create** (`CreateUserSchema`) since it is the login
identity; a duplicate email/username/phone now returns a 409 naming the field
rather than a raw 500.

**Why does `AuthController` never touch Prisma or bcrypt directly?** Same
Single-Responsibility split as `AppController`/`AppService` from Milestone
1, just with more at stake: the controller's whole job is translating
HTTP↔domain (extract the cookie, call the service, set the response cookie,
map thrown exceptions to status codes via Nest's built-in exception
filter). Every actual decision — is this password right, has this account
been locked out, is this refresh token being reused — lives in
`AuthService`, which has zero knowledge that HTTP exists.

**Why does `AuthService` call `this.prisma.refresh_tokens.*` directly
instead of through a `RefreshTokensRepository`, when it goes through
`UsersRepository` for the `users` table?** This is a deliberate
inconsistency worth naming rather than hiding: `UsersRepository` exists
because *multiple* future consumers will need user lookups (Milestone 7's
`GET /users/me`, later admin features) — the abstraction earns its keep.
`refresh_tokens` access, by contrast, is entirely internal to
`AuthService`'s own rotation/reuse-detection logic and has exactly one
consumer. Wrapping it in a repository now would be the premature
abstraction the project avoids elsewhere (see the `UsersRepository`
reasoning above) — introduce `RefreshTokensRepository` if and when a second
real consumer shows up, not before.

**Why is the lockout/rotation logic full of small guard clauses
(`if (!record || record.revoked_at)`, `if (record.consumed_at)`, `if
(record.expires_at < new Date())`) instead of one combined condition?** Each
guard maps to one distinct *security* reason for rejection (token doesn't
exist / already revoked / reused / expired), and each one currently returns
a different error or triggers different side effects (reuse specifically
revokes the whole family). Collapsing them would either lose that
distinction or require re-deriving it later — the verbosity here is carrying
real information, not accidental complexity.

## Global hardening (Milestone 6)

```
main.ts            — helmet, cors, hpp: process-wide middleware, applied once
AppModule           — ThrottlerModule + global APP_GUARD (ThrottlerGuard): IP-only floor, every route
AuthModule           — implements NestModule: doubleCsrfProtection scoped to POST /auth/refresh only
  └─ AuthController — LoginThrottlerGuard + @Throttle(...) on POST /auth/login only
```

**Why three different "scopes" of protection (process-wide middleware,
module-wide guard, route-specific guard/middleware) instead of one
consistent mechanism?** Each threat has a different natural boundary.
Helmet/CORS/HPP are about *every* HTTP response leaving the process — they
belong at the Express/Nest app level, applied once, no route ever opts out.
Rate limiting has a sensible universal floor (protect the whole app from
raw volume) *plus* a route where the generic floor isn't enough (login,
specifically, needs email-aware tracking) — that's a global guard with a
route-level override, not a single number. CSRF is meaningful for exactly
one route (the one cookie-authenticated endpoint) — scoping it globally
would either do nothing useful on routes with no cookie auth, or actively
break `/auth/login`'s legitimate first-contact request (which can't possibly
carry a CSRF token yet, since none has been issued). Matching each
mechanism's scope to the actual shape of the threat it addresses, rather
than reaching for one blanket setting, is the same instinct as the guard
clauses in `AuthService.refresh` — the structure follows the actual security
distinctions, not code-golf.

**Why does `AuthModule` implement `NestModule` for the CSRF middleware
instead of just `app.use('/auth/refresh', doubleCsrfProtection)` in
`main.ts`?** Both would work, but `configure(consumer: MiddlewareConsumer)`
keeps the "this middleware only applies to this module's own route" fact
local to the module that owns the route, instead of main.ts accumulating
path-string knowledge about every feature module's internals as the app
grows. It's the same module-boundary instinct as `@Global()` being the rare
exception rather than the default (Milestone 2) — `main.ts` should know
about app-wide concerns (helmet, cors), not route-by-route ones.

## Authentication spine (Milestone 7)

```
AppModule
├─ APP_GUARD: ThrottlerGuard   — runs first: cheap, rejects volume
└─ APP_GUARD: JwtAuthGuard     — deny by default; @Public() is the only opt-out
                                 injects Reflector + ITokenService (exported by AuthModule)
UsersModule
├─ UsersController — HTTP only: GET /users/me, takes @CurrentUser()
├─ UsersService     — decides whether the token's account is still usable
└─ UsersRepository  — Prisma access (Milestone 4)
```

**Why register the guard globally instead of `@UseGuards()` per controller?**
The two options differ in what happens when someone *forgets*. Per-route
protection fails open — a controller added later with no decorator is silently
public, and nothing in the test suite notices, because the endpoint works.
Global registration fails closed: forgetting `@Public()` on a route that needs
it produces a `401` the first time anyone calls it. For a system holding real
students' records, the failure mode you want is the loud one. This is the same
reasoning as the DB-enforced gender segregation in the spec (§5.1) — put the
rule where forgetting it is impossible rather than merely discouraged.

**Why is `POST /auth/logout` `@Public()`?** It looks like it should require
authentication, but it is authenticated — by the refresh cookie, which is the
only credential it consumes. Requiring an *access* token as well would mean a
user whose 15-minute token has expired cannot log out, which inverts the
security goal: the session that most needs ending would be the one that can't
be ended.

**Why does `UsersService.getProfile` re-check `deleted_at`/`is_active` when
`JwtAuthGuard` already accepted the token?** The guard verifies a *signature*,
which proves the token was issued by us and hasn't expired — it does not prove
the account still exists. Those are different claims, and only the second one
matters for handing back a profile. Deliberately keeping the check here rather
than in the guard: making the guard load the user from the database would add
a query to **every** authenticated request in the system to close a
15-minute-wide window, which the token TTL and refresh-token revocation
already bound. The cost belongs on the route that needs it, not on the whole
app.

**Why `AuthenticatedUser` holds only `{ id, role }`.** It is exactly the JWT's
claims and nothing more, so the type can't quietly become a place where
someone stashes data that required a database read. When branch scoping needs
`branchId` (Phase 1), it gets added to the token payload deliberately, in one
place, rather than being fetched per request.

## Phase 1 module map

```
AppModule
├─ APP_GUARD  ThrottlerGuard      — rate limit (cheapest, runs first)
├─ APP_GUARD  JwtAuthGuard        — authenticate; @Public() opts out
├─ APP_GUARD  RolesGuard          — authorize; @Roles() opts in
├─ APP_FILTER PrismaExceptionFilter — DB constraint violations → 409/404
├─ PrismaModule  (@Global)  — the connection
├─ CommonModule  (@Global)  — AuditService
├─ CryptoModule             — PASSWORD_HASHER, TOKEN_SERVICE
├─ AuthModule               — login/refresh/logout + CSRF middleware
├─ UsersModule              — users CRUD, /users/me
├─ ReferenceModule          — GeographyController + CatalogueController
├─ CalendarModule           — academic years, terms, Hijri generation
├─ CurriculumModule         — the year-scoped nesting builder
└─ SettingsModule           — progression rules, attendance policies,
                              institute settings, audit-log reads
```

**Why `CryptoModule` exists at all.** `AuthModule` already imports
`UsersModule` (it needs `UsersRepository`). Creating a user needs to hash a
password, so `UsersModule` needs `PASSWORD_HASHER` — importing `AuthModule`
back would be a cycle requiring `forwardRef()`. Moving the two provider
bindings into a leaf module both sides import removes the cycle instead of
papering over it. `forwardRef` works, but it is a marker that the module
boundaries are wrong, and here they were.

**Why the audit log is a service, not an interceptor.** The Phase 1 plan said
interceptor. An interceptor can see the request and the response; it cannot
see the row as it looked *before* the write, because by the time it runs the
write has happened. `audit_logs.before` is precisely the column that makes a
grade change (R8) or a soft delete (R9) reconstructable a year later, so the
call has to sit inside the service, between the read and the write. The
decorator `@CurrentActor()` supplies the IP and user-agent an interceptor
would otherwise have been convenient for.

**Why validation is duplicated between zod and the database.** The DDL has
`CHECK (pass_score <= max_score)`, `CHECK (warn_at_absences < max_absences)`,
`CHECK (ends_on > starts_on)` — and the services check the same things. This
is not redundancy for its own sake: Prisma cannot express CHECK constraints,
so a violation surfaces as an unmapped driver error and `PrismaExceptionFilter`
correctly turns it into a 500. Checking in the service is what turns "the
server broke" into "passScore must not exceed maxScore" on the right field.
The database keeps its constraint because it is the last line that a future
raw migration or bulk import still has to pass.

**Why the curriculum's two structural rules live in the application layer.**
The composite FK `(parent_curriculum_id, academic_year_id, level_id,
term_number)` already makes cross-level nesting impossible — that rule belongs
in the schema and is enforced there. The two it cannot express are §4.1's
depth cap of two, and "a parent is a container, so it is not examinable".
`CurriculumService.assertCanParent` holds exactly those two and nothing else;
everything the database can enforce is left to the database.

**Why services return view types rather than Prisma records.** Every service
maps to an explicit `*View` interface with camelCase keys. Three concrete
reasons, not style: `NUMERIC` columns arrive as Prisma `Decimal` and would
serialise as objects; `BIGSERIAL` ids arrive as `BigInt` and make
`JSON.stringify` throw outright; and the mapping is the boundary that keeps
`password_hash` and the WhatsApp identifiers out of responses by construction
rather than by remembering to omit them.

## Full module map (Phases 0–6 complete)

```
AppModule
├─ APP_GUARD  ThrottlerGuard        — rate limit (cheapest, first)
├─ APP_GUARD  JwtAuthGuard          — authenticate; @Public() opts out
├─ APP_GUARD  RolesGuard            — authorize;   @Roles()  opts in
├─ APP_FILTER PrismaExceptionFilter — DB constraint violations → 409/404
├─ PrismaModule  (@Global)  · CommonModule (@Global) · CryptoModule
├─ AuthModule · UsersModule · ReferenceModule · CalendarModule
├─ CurriculumModule · SettingsModule
├─ StudentsModule           — registry, placement, national-id reveal
├─ SectionsModule           — sections, teacher assignment, enrolments
├─ ImportModule             — Excel in (preview→commit) and out
├─ TeachingModule           — timetable, sessions, attendance grid
├─ AssessmentModule         — exams, eligibility, scores, promotion, certificates
├─ MessagingModule          — templates, campaigns, WhatsApp, cron
├─ ReportingModule          — dashboard aggregates
└─ ScheduleModule.forRoot() — §7.7: in-process cron, no Redis, no queue
```

**Why the rules engine is a folder of pure functions and not a service.**
`src/rules/` has no `@Injectable()`, no Prisma import and no Nest import at
all. Everything it needs arrives as plain data. Three consequences that
mattered in practice: the §4.3 evidence table could be tested exhaustively
without a database; the promotion service reduced to "load facts, call the
function, write the answer", which is where the *real* bug turned out to be
(the carry's forward enrolment); and when the spec's two pseudocode passes
disagreed, the difference was visible in one file instead of spread across a
service.

**Why services return `*View` types rather than Prisma records.** Four
concrete reasons, none of them style: `NUMERIC` arrives as `Decimal` and
serialises as an object; `BIGSERIAL` arrives as `BigInt` and makes
`JSON.stringify` **throw**; the composite foreign keys give relations names
like `carried_subjects_carried_subjects_enrollment_idToenrollments`, which no
API should expose; and the mapper is the boundary that keeps `password_hash`,
`national_id_enc` and the WhatsApp identifiers out of responses by
construction rather than by memory.

**Why the grids (attendance, scores) are one request each way.** A teacher
marks a class on a phone. The read is one query for sessions plus one for
enrolments-with-attendance, pivoted in memory; the write is one transaction of
upserts. Per-student requests would be thirty round-trips to render and would
leave the sheet half-saved when the connection dropped mid-class — which is
the normal case, not the edge case.

**Why `preview` and `commit` are separate endpoints, not one call with a
flag.** §6.3 makes the review step mandatory, and a boolean parameter is a
review step that can be skipped by passing `true`. Preview writes only to
`import_jobs`/`import_rows`; there is no code path from an upload to a
domain table that does not pass through a human.

**Why the promotion confirm names its enrolments.** The preview returns rows;
the confirm takes the ids back. It re-runs the same computation and applies it
only to the ids given, so a row the head teacher deselected stays deselected,
and a row created between preview and confirm is not swept in unreviewed. The
alternative — confirm re-selecting by year and level — would apply decisions
nobody looked at.

**Why `decidePromotion` and `decideAfterMakeup` are separate functions that
look nearly identical.** They are the case rule 19 warns about: the passes
differ in ways that read as copy-paste variants and are not. The first can
return `makeup_required`; the second cannot, because there is no second
makeup. R17 produces a makeup in the first and a repeat in the second. Merging
them behind a boolean would hide exactly the distinction that matters.

This file gets a new entry each milestone that changes the module map.
