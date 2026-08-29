<h1 align="center">📖 El&nbsp;Forkan — Backend API</h1>

<p align="center">
  <em>Quran institute management: students, sections, timetables, attendance,<br/>
  exams, promotion, certificates and WhatsApp reminders.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white" alt="Prisma 7" />
  <img src="https://img.shields.io/badge/Postgres-Supabase-3ECF8E?logo=supabase&logoColor=white" alt="Supabase Postgres" />
  <img src="https://img.shields.io/badge/Zod-validation-3E67B1?logo=zod&logoColor=white" alt="Zod" />
  <img src="https://img.shields.io/badge/tests-383%20passing-brightgreen" alt="383 tests" />
  <img src="https://img.shields.io/badge/routes-115-blue" alt="115 routes" />
</p>

---

## ✨ What's inside

| | Domain | Highlights |
|---|---|---|
| 🔐 | **Auth** | JWT access tokens (15 min) + opaque, peppered refresh tokens · CSRF double-submit · per-IP+username login throttle (5/min) |
| 👥 | **Users & students** | Role-scoped access, Arabic name normalisation, `national_id` encrypted at rest (AES-256-GCM) |
| 🗓️ | **Calendar** | Hijri ↔ Gregorian year planner, terms, holidays |
| 📚 | **Curriculum** | Year → level → subject → term tree, scores and weights |
| 🏫 | **Sections & teaching** | Timetable clash detection, session generation, attendance grid, absence thresholds |
| 📝 | **Assessment** | Exams, eligibility, score entry + lock, corrections, term results, promotion, COMP gate |
| 🎓 | **Certificates** | Auto serials (`L4-1447-0001`), reprint a lost copy, re-issue after revocation |
| 💬 | **Messaging** | Templates, phone-coverage gate, idempotent campaigns, cron reminders, WhatsApp client |
| 📊 | **Reporting** | Dashboard aggregates, scoped per role |
| 📥 | **Import / export** | Excel rosters and results — **preview then commit**, nothing touches a domain table until you say so |

---

## 🚀 Quick start

```bash
npm install
cp .env.example .env          # then fill in the blanks (see below)
npx prisma generate
npm run start:dev             # http://localhost:3000
```

Health check: `GET /health` → `{ "status": "ok", "timestamp": … }`

### Environment

Every key in [.env.example](.env.example) is required except `REFRESH_TOKEN_PEPPER`
and the WhatsApp credentials (sending stays inert without them — campaigns
queue instead of failing).

> ⚠️ Both Postgres URLs need `sslmode=no-verify`, **not** `require` — newer
> `pg-connection-string` reads `require` as full CA verification, which the
> Supabase pooler cert fails. Diagnosis in [agent/memory.md](agent/memory.md).

Generate the two crypto keys:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## 🧱 Architecture

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

**Hardened by default:** `helmet` · `cors` (credentialed) · `hpp` ·
`cookie-parser` · global `ZodValidationPipe` with `.strict()` schemas.

---

## 🗺️ API map

| Prefix | Routes | | Prefix | Routes |
|---|--:|---|---|--:|
| `/auth` | 4 | | `/sections`, `/enrollments` | 10 |
| `/users` | 6 | | `/sessions`, teaching | 9 |
| `/students` | 8 | | assessment & certificates | 21 |
| reference & geography | 19 | | `/reports` | 5 |
| calendar & curriculum | 12 | | messaging | 6 |
| `/settings` | 7 | | `/imports`, `/exports` | 7 |

Plus `GET /health`. Routes with no `@Roles()` are open to any authenticated user; `@Roles('head_teacher')`
guards anything that destroys data, rewrites history, or changes the rules.

---

## 🧪 Testing

Two tiers — Jest for pure logic, live smoke suites for the wiring.

```bash
npm test          # 383 unit tests, 29 suites
npm run test:cov  # coverage
```

```bash
npm run start:dev              # terminal 1
node test/smoke/b5-smoke.mjs   # terminal 2
```

Smoke suites drive the real HTTP API against the live database — see
[test/smoke/README.md](test/smoke/README.md). **Run them one at a time**: login
is throttled at 5/min and back-to-back runs exhaust the window.

---

## 📜 Scripts

| Command | Does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run start:prod` | `node dist/main` |
| `npm run build` | `nest build` |
| `npm run lint` | ESLint `--fix` |
| `npm run format` | Prettier |

---

## 📓 Project journal

- [agent/architecture.md](agent/architecture.md) — module map and *why* each shape
- [agent/progress.md](agent/progress.md) — milestone log, decisions, open questions
- [agent/memory.md](agent/memory.md) — gotchas that cost real time
- [docs/nestjs-for-express-developers.md](docs/nestjs-for-express-developers.md)

**Status:** backend Phases 0–6 complete — 115 routes live. Frontend not started.
