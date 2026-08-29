# Full-scope delivery plan — معهد الفرقان SMS

## Context

`furqan-spec-v1.1.md` is reviewed and final. **Nothing is cut** — every rule
R1–R20, every table in `schema-v1.1.sql`, every §8 phase and every §9 checklist
item ships. The earlier lean plan is withdrawn and deleted.

**Status: the backend track (B1–B7) is complete.** Paths below are the
intended ones; where the build landed somewhere else the note says so, and
[progress.md](backend/agent/progress.md) is the record of what was actually
built.

Where we are: Phase 0 is done through Milestone 6 (see
[progress.md](backend/agent/progress.md)) — Nest + Prisma on live Supabase, zod
pipe, helmet/cors/hpp/throttler, auth with rotation + family revocation +
lockout, CSRF on `/auth/refresh`. 39 tables applied and introspected. No
frontend exists yet.

Decisions taken for this plan: **backend-first, then frontend**; real Excel
workbooks and syllabus sheets will be provided; **sequential** work, no
subagents.

The clock pressure is real, so the plan's job is to remove *blocking* items
early (external lead times, missing data, DB safety) rather than to reduce
scope. Speed comes from ordering and from not rewriting things twice.

### The one risk of backend-first, and the mitigation

Building all six phases of API with no UI defers every integration bug to the
end. Mitigation, applied from B1 onward and non-optional: **each backend phase
ends with a supertest e2e spec under `backend/test/`** that drives the phase's
real endpoints against the live DB (login → act → assert), plus a
`backend/test/*.http` REST-client file for manual poking. A phase is not "done"
until its e2e spec passes. This is what replaces the missing UI as proof.

---

## Standing rules (apply to every step below)

**Performance**
- Every list endpoint: cursor or offset pagination with a hard `take` ceiling
  (100), enforced in one shared `PageQuerySchema` — not per-endpoint.
- Every query `select`s only the columns the caller needs. No bare
  `findMany()` on `students`/`enrollments`.
- Grid screens (attendance student×session, score entry) load in **one** query
  with `include`, never N+1 per student.
- The DDL's indexes are already correct — don't add more without an `EXPLAIN`
  showing a seq scan on real row counts.
- Pooler stays `connection_limit=1` (§7.6). No connection-pool tuning games.

**Security** (§9, all of it)
- One `JwtAuthGuard` global + `@Public()` opt-out; one `RolesGuard`; one
  **scope layer** at the repository boundary — never an `if` in a controller.
- UUIDs only in URLs (already true for students/sections/enrollments; note
  `levels`/`subjects`/`curriculum` are serial ints — they are catalogue data,
  not PII, so that's acceptable; never expose a serial id that identifies a
  person).
- Excel in: formula-free reads, size + row caps, parse timeout,
  `Object.create(null)`. Excel out: CSV-injection prefix guard.
- `national_id_enc` encrypted app-side (AES-256-GCM, key in env), never
  plaintext in a query.
- Rate limits on login, refresh, **import**, and **WhatsApp send**.
- Audit every export with actor + row count.
- **RLS**: the `DO $$` block at the end of `schema-v1.1.sql` is still
  commented out. Run it (step B0).

**Clean code / architecture**
- Keep the shape already documented in
  [architecture.md](backend/agent/architecture.md): `Controller` (HTTP only) →
  `Service` (decisions) → `Repository`/Prisma. Update that file every step
  that changes the module map — it's a standing rule in
  [memory.md](backend/agent/memory.md), as is keeping
  [docs/nestjs-for-express-developers.md](backend/docs/nestjs-for-express-developers.md)
  current.
- **Rules engine = pure functions.** §4.2 scoring, §4.3 promotion, §4.4 COMP
  gate, §4.6 eligibility, §4.8 thresholds go in `src/rules/` as functions
  taking plain data and returning a decision. No Prisma, no Nest, no mocks
  needed to test them. This is the highest-value testing decision in the
  project — the rules are where a bug silently rewrites a real student's record.
- No new abstraction without two real implementations (the `IPasswordHasher`
  vs `UsersRepository` distinction already reasoned out in architecture.md).

---

## Do these NOW — they have lead time or protect data

| # | Action | Why |
|---|---|---|
| N1 | **Start Meta WhatsApp Business verification** | §7.8: template approval takes days. It is the only external dependency that can block a finished Phase 5. |
| N2 | **Enable Supabase PITR / backups** | §7.6.5. Real grade data is about to land. |
| N3 | **Run the RLS `DO $$` block** (uncomment, execute via `prisma db execute`) | §7.6.2 defence-in-depth; currently not applied. |
| N4 | **Create ONE private Supabase Storage bucket** (`furqan`), prefixes `imports/`, `exports/`, `certificates/`. Set a ~10 MB file-size limit + allowed MIME types at bucket level; zero RLS policies on `storage.objects`; signed URLs only, issued by Nest | §7.6.4, needed by B3. One bucket because all three uses share identical settings — split only if certificates later need public verification links or different retention. |
| N5 | **`git init` in `backend/`** (and `frontend/` when scaffolded) | §7.9 — two repos. Also: no version control at all right now, which is the real risk. |
| N6 | **Drop the 5 Excel workbooks + 5 syllabus sheets** into `Project/data/` | Unblocks B2 curriculum seed and B3 import. |
| N7 | Decide §10 open items: `student_code` format, certificate text + `serial_no` format, and the curriculum `max_score`/`pass_score`/`weight`/`إلزامية` values | B2/B3/B5 need them; sensible defaults are in place but the mandatory flags genuinely block promotion (R17). |

---

## Backend track

### B0 — Close Phase 0 (Milestone 7) + the authorization spine
The single most reusable step; everything after depends on it.

- `src/auth/guards/jwt-auth.guard.ts` — global `APP_GUARD`, with a
  `@Public()` decorator for `/health`, `/auth/login`, `/auth/refresh`.
- `src/auth/guards/roles.guard.ts` + `@Roles('head_teacher')` — drives the
  entire §3 capability table.
- Built as `src/common/access-scope.ts`, not under `auth/`: the fragments it
  returns are Prisma where-clauses consumed by every feature module. An
  `AccessScope` built from the JWT
  (`{ userId, role, branchId, gender }`) and a `ScopeService` that returns
  Prisma `where` fragments: branch scoping for everyone, plus
  `section_teachers`-based filtering for `teacher`. **Head teacher with
  `branch_id IS NULL` sees all branches** (§3 forward-compat).
- `GET /users/me` using the existing `UsersRepository` +
  [users.mapper.ts](backend/src/users/users.mapper.ts).
- `src/common/` — `PageQuerySchema` + pagination helper, `AuditInterceptor`
  writing `audit_logs`, `SoftDeleteService` (reason mandatory, R9),
  `arabic.ts` normalisation (tashkeel strip, ة→ه, أإآ→ا, ى→ي, tatweel
  `ـ`, whitespace collapse) — used by both seeding and import, written
  once here.
- Run N3 (RLS).
- **e2e**: `test/authz.e2e-spec.ts` — the §9 test that actually matters:
  *teacher A cannot read section B*. Also: teacher blocked from every
  head-teacher-only route in the §3 table.

### B1 — Foundation (spec Phase 1)
- Users CRUD (head-teacher only) with gender + branch, soft delete w/ reason.
- Geography + catalogue: `governorates`, `markazes`, `branches`, `levels`,
  `subjects`, `subject_aliases`, `books` — full CRUD endpoints per §3
  (head-teacher owned), seeded from `schema-v1.1.sql`'s existing seed block.
- `academic_years` + `terms` with **Hijri generation via `@umalqura/core`
  then head-teacher override** (§7.5 — generated dates are *suggestions*,
  Gregorian is stored truth).
- **Curriculum builder API** — the hard one: year-scoped rows, self-nesting via
  `parent_curriculum_id` with **depth capped at 2 in the app layer** (§4.1),
  `is_examinable`/`is_mandatory`/`grading_mode`/`max_score`/`pass_score`/
  `weight`, plus `curriculum_units` (books, syllabus scope,
  `alternative_group`).
- `progression_rules` + `attendance_policies` + `institute_settings` endpoints
  (carry limits per level, absence limits — R13, §4.8).
- Audit log read endpoint.
- **e2e**: curriculum nesting depth rejected at 3; a child forced to share
  `(year, level, term)` with its parent; teacher role rejected on all of the above.

### B2 — Rules engine (pure, no HTTP)
Pulled forward out of Phase 4 deliberately: it has no dependencies, it is
where correctness matters most, and having it done makes B5 assembly instead
of design.

- `src/rules/scoring.ts` — §4.2 result + weighted term totals.
- `src/rules/promotion.ts` — §4.3 both passes (initial + post-makeup),
  verbatim from the spec's pseudocode.
- `src/rules/comp-gate.ts` — §4.4 `can_enter_comp`.
- `src/rules/eligibility.ts` — §4.6 predicate + `reason_code` selection,
  including carries scanned across **all** prior enrollments.
- `src/rules/absence.ts` — §4.8 thresholds.
- **Tests**: one `.spec.ts` per file, table-driven, including the §4.3 carry-limit
  evidence table (1/2/3 → carry, 4+ → repeat) and the R15 PREP no-carry case.

### B3 — Students, sections, enrollments, Excel (spec Phase 2)
- Student registry + profile (phone via `libphonenumber-js` EG → E.164,
  **reject** don't coerce), `national_id_enc` AES-256-GCM,
  `student_code` per N7.
- `placement_assessments` — both §4.7 routes, matching the DDL CHECKs.
- `sections` per branch×year×level×gender; `section_teachers` assignment
  (gender guard is already structural — surface the FK violation as a clean 409).
- `enrollments` with `entry_type`; `carried_subjects`.
- Built as `src/excel/workbook-loader.ts` + `sheet-reader.ts` + `cell-value.ts`
  (loading with the §9 caps, mapping columns by header text, and reducing a
  cell safely are three separate jobs) — `exceljs`, **header-text mapping
  never fixed index**
  (§6.2 ⚠), formula-free/cached values only, size+row caps, parse timeout,
  `Object.create(null)`.
- **Import with preview-then-commit** (§6.3): `import_jobs` + `import_rows`,
  per-row `create|update|skip|error`, teacher fixes, then commit. Unresolved
  subject token flags the row — **never auto-create a subject**.
- Built as `src/excel/roster-writer.ts` — export mirroring the printed layout (two sheets,
  merged header, data row 6) + **CSV-injection guard** (§6.5).
- Phone-coverage indicator per section.
- **1447 historical back-fill** (§6.4), `is_historical = TRUE`, exam_results
  skipped, promotion engine **never** run over these rows.
- Rate limit on the import path.
- **e2e**: import the real workbooks into a scratch year → assert row counts,
  the L3 أخوات 18-outcome-no-names sheet errors cleanly, `سيرة`/`سيره` both
  resolve, PREP file (starts at column F) parses correctly.

### B4 — Teaching (spec Phase 3)
- **Timetable builder** with teacher clash detection (`sessions` already
  indexed on `(teacher_id, session_date)`).
- Session generation — `sessions_per_term` (15) from `institute_settings`,
  default weekday Friday, off-day/exception handling, online/hybrid with
  `meeting_url` (the DDL CHECK enforces it).
- **Attendance grid** — student × session, one query in, one bulk upsert out.
- Absence counters + `attendance_policies` thresholds, `attendance_warnings`
  queued idempotently on `(enrollment, term, threshold)`, nightly sweep via
  `@nestjs/schedule`.

### B5 — Assessment (spec Phase 4)
Mostly wiring, because B2 already holds the logic.
- Exam scheduling from examinable curriculum rows, inheriting max/pass (§4.2).
- **Eligibility engine** → materialise `exam_eligibility` rows with
  `reason_code` + head-teacher override path; filtered lists per §4.6.
- Score entry grid + lock; head-teacher correction writing `grade_changes`
  with mandatory reason (R8).
- `term_results` computed and **frozen on finalisation**.
- Makeup round → second promotion pass.
- **Promotion run**: preview → confirm → next year's enrollments +
  `carried_subjects`. Refuses to touch `is_historical` rows.
- **COMP entry gate** on enrollment (R20).
- **Certificates**: "ready to certify" list, issue, revoke w/ reason (R19, §4.5).

### B6 — Communication (spec Phase 5)
- WhatsApp Cloud API client; token from **env only** (§7.8).
- `message_templates` management; Thursday cron via `@nestjs/schedule`.
- Idempotency: `message_campaigns` unique `(template_id, section_id,
  target_date)` + `job_runs` `(job_name, run_key)` claimed transactionally
  **before** work (§7.7).
- `p-limit` ~5 concurrent, per-message status, retry only `failed`.
- Delivery webhooks → `messages.status`.
- Absence warnings wired to B4's thresholds.
- **Escape student names before interpolating into templates** (§9 XSS).
- Rate limit the send path — "a loop bug here messages real people".
- Reminder stays **off per section until phone coverage is adequate** (§6.4).

### B7 — Reporting API (spec Phase 6, backend half)
Dashboard aggregates (headcount by level/gender/markaz, attendance trends,
pass rates) as SQL aggregates, not row fetches.

---

## Frontend track (starts after B7)

`frontend/` — React + Vite + TS + Tailwind, own repo, own `.gitignore`.

- **F0 — Shell**: `<html lang="ar" dir="rtl">`, i18next + `ar.json` (no Arabic
  literals in components, §7.4), self-hosted Cairo/IBM Plex Arabic + Noto Naskh
  woff2, logical Tailwind utilities only (`ps-`/`pe-`/`ms-`/`me-`/`text-start`),
  Latin digits via `Intl.NumberFormat('ar-EG-u-nu-latn')`. Router + Render SPA
  rewrite. **RTK Query configured with tag types from day one**
  (`Student`, `Section`, `Attendance`, `ExamResult`, `Enrollment`,
  `Certificate`, …) + `transformResponse` at the endpoint (§7.2). Login +
  `/users/me` protected route — Phase 0's exit criterion, finally closed.
- **F1** Foundation screens: users, catalogue, years/terms, **curriculum
  builder** (the hardest screen — nested tree editor, depth 2).
- **F2** Students, placement, sections, enrollments, **import preview UI**,
  export, phone-coverage badge.
- **F3** Timetable, **attendance grid** (mobile-first, shaped like the printed
  sheet).
- **F4** Exams, eligibility lists, score grid + lock, correction dialog with
  mandatory reason, promotion run preview→confirm, COMP gate, certificates.
- **F5** WhatsApp console; **F6** dashboards + A4 RTL print stylesheets
  (roster, result sheet) + **certificate PDF**.
- Lint bans `dangerouslySetInnerHTML`; CSP has no `unsafe-inline`.
- zod schemas duplicated from backend per §7.9 (revisit only if painful).

## Deploy (after F0 exists)

Render: one Project, two services (§7.10). **Before shipping past local dev,
fix the cross-subdomain cookie gotcha** — custom domain under one registrable
root (recommended) or `SameSite=None; Secure` as a stopgap. Set `CORS_ORIGIN`,
pin Node via `engines`/`.node-version`, health check `GET /health`, migrations
via the direct `:5432` URL as a pre-deploy command.

---

## Verification

Per step, in order of cost:

1. `npx eslint src` clean + `npm test` green (unit — the `src/rules/` specs are
   the ones that must never go red).
2. `npm run test:e2e` — the phase's supertest spec against the live Supabase DB.
3. Clean `npm run start:dev` boot showing every module resolving with no DI
   errors (this has caught real bugs twice already, per progress.md).
4. Manual `.http` poke for anything shaped oddly (cookies, file upload, cron).

Whole-system acceptance, once B0–B7 + F0–F6 are done:
- Import the real 1447 workbooks → 96 students, correct genders, correct
  decisions, carries resolved, `is_historical` set.
- Create 1448, build curriculum, enrol students, generate sessions, take
  attendance, run exams, enter scores, run the promotion preview → confirm,
  issue a certificate, print a roster — as the head teacher, in Arabic, RTL.
- As a teacher: every head-teacher-only action returns 403.

## Bookkeeping

Update [progress.md](backend/agent/progress.md) per step,
[architecture.md](backend/agent/architecture.md) whenever the module map
changes, [memory.md](backend/agent/memory.md) for gotchas, and
[docs/nestjs-for-express-developers.md](backend/docs/nestjs-for-express-developers.md)
whenever a new Nest concept appears (standing instruction).
