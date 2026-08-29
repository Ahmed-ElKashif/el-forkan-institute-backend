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
| `b1-smoke.mjs` | reference data, Hijri year generation, curriculum nesting, progression rules, audit log |
| `b3-smoke.mjs` | students, sections, the R3 gender guards, enrolments, Excel import/export |
| `b4-smoke.mjs` | timetable clash detection, session generation, attendance grid, absence thresholds |
| `b5-smoke.mjs` | exams, eligibility, score entry and lock, R8 corrections, term results, promotion, COMP gate, certificates |
| `b6-smoke.mjs` | message templates, phone-coverage gate, campaign idempotency, send path rate limit |
| `b7-smoke.mjs` | dashboard aggregates and their scoping |
| `cert-smoke.mjs` | graduation at L4, serial generation, reprinting a lost certificate, re-issuing after revocation |

## Two things to know

**Run them one at a time.** `/auth/login` is throttled at 5/min per IP+username
(spec §7.3), and each suite logs in several times. Running them back to back
exhausts the window and later suites fail with `401` because the login returned
`429` and there was no token. Wait for a successful login before starting the
next one.

**They create data and do not clean up.** That is deliberate — the point is to
exercise the real constraints, and a suite that tore its own data down would
never hit the "this already exists" paths. Where a re-run would legitimately
collide (curriculum is UNIQUE per year/level/subject/term, exams per
term/curriculum/gender/type), the suite creates its **own academic year** and
works inside it. Anything asserting on institute-wide reference data accepts
either "created" or "already there".
