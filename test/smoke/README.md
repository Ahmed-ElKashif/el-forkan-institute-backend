# Live smoke suites

End-to-end checks that drive the real HTTP API against the live Supabase
database. They are the "verify it actually works" tier described in
`agent/progress.md` — Jest covers pure logic, these cover the wiring.

## Running

Start the server, then run one suite:

```
npm run start:dev            # in one terminal
node test/smoke/b5-smoke.mjs # in another
```

Each script prints one PASS/FAIL line per assertion and exits non-zero if any
failed.

| File | Covers |
|---|---|
| `auth.mjs` | shared harness helper — mints an access token (see *Signing in*) |
| `classes-smoke.mjs` | provisioning the year's classes, one-class-per-level (R1 × R3), carried subjects |
| `b1-smoke.mjs` | reference data, Hijri year generation, curriculum nesting, progression rules, audit log |
| `b7-smoke.mjs` | dashboard aggregates and their scoping |
| `cert-smoke.mjs` | graduation at L4, serial generation, reprinting a lost certificate, re-issuing after revocation |

## Signing in

Sign-in is two-factor (F12): `POST /auth/login` returns a *challenge*, and only
`POST /auth/verify-otp` issues a session — with a code that is emailed and stored
hashed. A script cannot read that code back, so suites do **not** log in. They
mint their own access token with `tokenFor()` from `auth.mjs`, using the same
secret and claims the server verifies.

`b1`, `b7` and `cert-smoke` still call `/auth/login` expecting an `accessToken`
and therefore **do not run** as written; they predate 2FA. Port them to
`auth.mjs` before relying on them.

## Two things to know

**Classes are provisioned, never invented.** `POST /sections/provision` creates
one class per level per gender; a suite that needs a class looks one up. The
retired `b3`–`b6` each created their own L1 section on every run, which is how
29 classes ended up on one level with none anywhere else — and the
one-class-per-level unique key now refuses that outright.

**They create data and do not clean up.** That is deliberate — the point is to
exercise the real constraints, and a suite that tore its own data down would
never hit the "this already exists" paths. Where a re-run would legitimately
collide (curriculum is UNIQUE per year/level/subject/term, exams per
term/curriculum/gender/type), the suite creates its **own academic year** and
works inside it. Anything asserting on institute-wide reference data accepts
either "created" or "already there".
