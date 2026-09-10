<div align="center">

<img src="docs/assets/logo.png" alt="دورات الفرقان التثقيفية" width="200" />

# El Forkan Institute — Backend API

**دورات الفرقان التثقيفية**

Quran institute management: students, sections, timetables, attendance,<br/>
exams, promotion, certificates and WhatsApp reminders.

<br/>

![NestJS](https://img.shields.io/badge/NestJS-11-109989?style=for-the-badge&logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-0D8073?style=for-the-badge&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-0A665C?style=for-the-badge&logo=prisma&logoColor=white)
![Postgres](https://img.shields.io/badge/Supabase-Postgres-084F47?style=for-the-badge&logo=supabase&logoColor=white)

![Routes](https://img.shields.io/badge/routes-131-C5852D?style=for-the-badge)
![Tests](https://img.shields.io/badge/tests-396_passing-C5852D?style=for-the-badge)
![Zod](https://img.shields.io/badge/validation-Zod-A76D24?style=for-the-badge)

</div>

<br/>

<div align="center">

### The two halves of this system

<table>
<tr>
<td align="center" width="50%">

**Backend API**

`NestJS` · `Prisma` · `Postgres`

📍 **You are here**

</td>
<td align="center" width="50%">

**[Frontend SPA →](https://github.com/Ahmed-ElKashif/el-forkan-institute-frontend)**

`React` · `Vite` · `Tailwind`

Arabic-first, right-to-left admin app

</td>
</tr>
</table>

</div>

---

## What's inside

| Domain | Highlights |
|---|---|
| **Auth** | JWT access tokens (15 min, algorithm/issuer/audience-pinned) + opaque, peppered refresh tokens · CSRF double-submit · per-IP+username login throttle (5/min) · self-service + head-teacher password reset |
| **Users & students** | Role-scoped access, Arabic name normalisation, `national_id` encrypted at rest (AES-256-GCM) |
| **Calendar** | Hijri ↔ Gregorian year planner, terms, holidays |
| **Curriculum** | Year → level → subject → term tree, scores and weights |
| **Sections & teaching** | Timetable clash detection, session generation, attendance grid, absence thresholds |
| **Assessment** | Exams, eligibility, score entry + lock, corrections, term results, promotion, COMP gate |
| **Certificates** | Auto serials (`L4-1447-0001`), reprint a lost copy, re-issue after revocation |
| **Messaging** | Templates, phone-coverage gate, idempotent campaigns, cron reminders, WhatsApp client |
| **Reporting** | Dashboard aggregates, scoped per role |
| **Import / export** | Excel rosters and results — **preview then commit**, nothing touches a domain table until you say so |

---

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the blanks (see below)
npx prisma generate
npm run start:dev             # http://localhost:3000
```

Health check: `GET /health` → `{ "status": "ok", "timestamp": … }`

Seeded head teacher for local work: `headteacher` / `ChangeMe123!`
([prisma/seed-head-teacher.ts](prisma/seed-head-teacher.ts)). **Rotate it in any
shared environment** via `POST /users/me/password` — the default is a known
static credential.

> [!WARNING]
> Both Postgres URLs need `sslmode=no-verify`, **not** `require` — newer
> `pg-connection-string` reads `require` as full CA verification, which the
> Supabase pooler cert fails. Diagnosis in [agent/memory.md](agent/memory.md).

### Environment

Config is **validated at boot** ([src/config/env.ts](src/config/env.ts)): the
process refuses to start if `JWT_ACCESS_SECRET` (≥32 chars), `CSRF_SECRET`
(≥16), `FIELD_ENCRYPTION_KEY`, `DATABASE_URL` or — in production — `CORS_ORIGIN`
is missing, with one aggregated error naming every offender. `REFRESH_TOKEN_PEPPER`
and the WhatsApp credentials stay optional (sending stays inert without them —
campaigns queue instead of failing).

`CORS_ORIGIN` is a fail-closed, comma-separated allowlist (no `*` fallback).
Cookie `Secure` defaults **on**; set `COOKIE_SECURE=false` for local HTTP dev, or
the browser drops the refresh cookie.

Generate the two crypto keys:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## Architecture

```
AppModule
├─ PrismaModule (@Global)  — connection lifecycle on Nest's own boot sequence
├─ CommonModule            — audit, access scope, pagination, Hijri, phone, crypto
├─ AuthModule              — IPasswordHasher / ITokenService behind DI tokens
├─ Users · Reference · Calendar · Curriculum · Settings
├─ Students · Sections · Import · Teaching · Assessment
├─ Messaging               — ScheduleModule cron, no Redis, no queue
└─ Reporting
```

Global guards run in order — **throttle → JWT → roles** — so rate limiting
happens before any CPU is spent verifying a token, and authorization runs last
because it needs `request.user`. `PrismaExceptionFilter` maps DB constraint
violations to real HTTP statuses.

Idempotency lives in the database, not a queue: `message_campaigns` is UNIQUE
on `(template, section, date)` and `job_runs` on `(job_name, run_key)` — claimed
before the work starts. Full reasoning in [agent/architecture.md](agent/architecture.md).

**Hardened by default:** boot-time env validation · `helmet` (CSP +
`frame-ancestors`/`base-uri 'none'`) · fail-closed `cors` allowlist
(credentialed) · `hpp` · `cookie-parser` · global `ZodValidationPipe` with
`.strict()` schemas · branch scoping enforced in every service (`viewer`
threaded through the data layer, not the controller).

---

## API map

| Prefix | Routes | | Prefix | Routes |
|---|--:|---|---|--:|
| `/auth` | 4 | | `/sections`, `/enrollments` | 10 |
| `/users` | 8 | | `/sessions`, teaching | 9 |
| `/students` | 8 | | assessment & certificates | 21 |
| reference & geography | 19 | | `/reports` | 5 |
| calendar & curriculum | 12 | | messaging | 6 |
| `/settings` | 7 | | `/imports`, `/exports` | 7 |

Plus `GET /health`. Routes with no `@Roles()` are open to any authenticated user
**but branch-scoped in the service layer** (a teacher only ever sees their own
branch's data); `@Roles('head_teacher')` guards anything that destroys data,
rewrites history, or changes the rules — **53 of the 131**.

### Two roles, and only two

| Role | Scope | Can |
|---|---|---|
| **مدير** `head_teacher` | branch or whole institute | everything, including every destructive and history-rewriting action |
| **معلّم** `teacher` | own sections only | read plus day-to-day entry |

---

## Testing

Two tiers — Jest for pure logic, live smoke suites for the wiring.

```bash
npm test          # 396 unit tests, 30 suites
npm run test:cov  # coverage
```

```bash
npm run start:dev              # terminal 1
node test/smoke/b5-smoke.mjs   # terminal 2
```

Smoke suites drive the real HTTP API against the live database — see
[test/smoke/README.md](test/smoke/README.md).

> [!TIP]
> **Run smoke suites one at a time.** Login is throttled at 5/min per
> IP+username, and back-to-back runs exhaust the window.

---

## Scripts

| Command | Does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run start:prod` | `node dist/main` |
| `npm run build` | `nest build` |
| `npm run lint` | ESLint `--fix` |
| `npm run format` | Prettier |
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`) |
| `npm run db:migrate:status` | Show which migrations are applied |
| `npm run db:migrate:new -- <name>` | Scaffold the next migration from schema changes |
| `npm run db:manual` | Emergency repair: re-create the partial unique indexes a stray `db push` dropped |

---

## Database & migrations

[`prisma/schema.prisma`](prisma/schema.prisma) is the source of truth for the
Prisma client; [`prisma/migrations/`](prisma/migrations) is the source of truth
for the database. The `0_init` baseline reproduces the full production schema —
39 tables, 104 foreign keys, 21 enums, **28 CHECK constraints and 2 partial
unique indexes** — and is marked as already-applied on the existing database, so
it only ever runs against a fresh one. It was verified by replaying it into a
throwaway schema and diffing the result against production.

**Changing the schema**

```bash
# 1. edit prisma/schema.prisma, then:
npm run db:migrate:new -- add-something   # writes prisma/migrations/<ts>_add_something/
# 2. REVIEW the generated SQL (a rename reads as DROP + ADD and would lose data)
npm run db:migrate                        # apply it
npx prisma generate                       # refresh the client
```

> [!CAUTION]
> **Never run `prisma db push` on this database.** Prisma cannot express a
> partial unique index, so a push silently *drops* the two that guarantee one
> live certificate per student/level and one primary teacher per section — it did
> exactly that on 2026-08-30. If it happens again, repair with `npm run db:manual`.
>
> For the same reason every `migrate diff` reports those two indexes as drift and
> tries to `DROP` them. `db:migrate:new` strips those statements for you and says
> so; if you ever hand-write a migration, do not re-add them.

A Render Blueprint ships in [`render.yaml`](render.yaml) — import this repo,
then fill the `sync: false` secrets in the dashboard.

Migrations apply automatically on deploy — `prisma migrate deploy` runs in the
build command, before the new code goes live.

> [!IMPORTANT]
> `COOKIE_SAMESITE` decides whether the refresh cookie survives after deploy. On
> two separate `*.onrender.com` subdomains the API and SPA are cross-site, so it
> must be `none` (the blueprint's default); under one registrable domain leave it
> `strict`. Get this wrong and login works while every refresh silently fails.

Full two-service runbook and the exit test: the frontend repo's
[`DEPLOY.md`](https://github.com/Ahmed-ElKashif/el-forkan-institute-frontend/blob/main/DEPLOY.md).

---

## Project journal

Living documents, kept current as the build moves:

| Doc | Answers |
|---|---|
| [agent/architecture.md](agent/architecture.md) | The module map, and *why* each piece is shaped that way |
| [agent/progress.md](agent/progress.md) | Milestone log, decisions taken, questions still open |
| [agent/memory.md](agent/memory.md) | Gotchas that cost real time — read before debugging |
| [docs/nestjs-for-express-developers.md](docs/nestjs-for-express-developers.md) | Nest concepts, for an Express background |

---

<div align="center">

**Status:** backend Phases 0–6 complete · 131 routes live · external security
review remediated.<br/>
Frontend is at F0c — sign-in, session and the role-scoped app frame working.
[See the frontend repo →](https://github.com/Ahmed-ElKashif/el-forkan-institute-frontend)

<sub>دورات الفرقان التثقيفية · El Forkan Institute</sub>

</div>
