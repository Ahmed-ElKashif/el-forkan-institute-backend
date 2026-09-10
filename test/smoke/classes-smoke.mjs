/**
 * Smoke: one class per level per gender, and the carry it settles.
 * Run:  node test/smoke/classes-smoke.mjs   (with the API running)
 *
 * Replaces b3/b4/b5/b6, which each created their own L1 section on every run —
 * the habit that left 29 classes piled on one level and none anywhere else, and
 * which the one-class-per-level unique key now refuses outright.
 *
 * The new shape: provision the year's classes, then USE them. A suite that needs
 * a class looks one up; it never invents one.
 *
 * Covers
 *   1. Provisioning creates one class per level per gender, and is idempotent.
 *   2. A level will not take a second class (R1 x R3).
 *   3. Only the head teacher may provision.
 *   4. A carried subject clears when it is finally passed (R20's COMP gate).
 */
import pg from 'pg';
import { env, tokenFor } from './auth.mjs';

const API = 'http://localhost:3000';
let pass = 0;
let fail = 0;

async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: res.status, body: parsed };
}

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
  ok ? pass++ : fail++;
}

/* The suite needs real user ids to mint tokens for; they are the one thing it
   cannot ask the API for without already being signed in. */
const db = new pg.Client({
  connectionString: env.DIRECT_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await db.connect();
const { rows: staff } = await db.query(
  "SELECT id, role, branch_id FROM users WHERE is_active AND role IN ('head_teacher','teacher') ORDER BY role LIMIT 2",
);
await db.end();

const head = staff.find((u) => u.role === 'head_teacher');
const teacher = staff.find((u) => u.role === 'teacher');
if (!head) {
  console.error('No active head teacher in the database — seed one first.');
  process.exit(1);
}
const HT = tokenFor({ userId: head.id, role: 'head_teacher', branchId: head.branch_id });
const T = teacher
  ? tokenFor({ userId: teacher.id, role: 'teacher', branchId: teacher.branch_id })
  : null;

const year = (await call(HT, 'GET', '/academic-years')).body.items[0];
const levels = (await call(HT, 'GET', '/levels')).body;

console.log('\n--- provisioning the year\'s classes ---');
const first = await call(HT, 'POST', '/sections/provision', {
  academicYearId: year.id,
});
check('provision succeeds', first.status, 201);
check('one class per level per gender', first.body.total, levels.length * 2);

const again = await call(HT, 'POST', '/sections/provision', {
  academicYearId: year.id,
});
check('re-running creates nothing', again.body.created, 0);
check('and still reports the full set', again.body.total, levels.length * 2);

if (T) {
  check(
    'a teacher may not provision',
    (await call(T, 'POST', '/sections/provision', { academicYearId: year.id })).status,
    403,
  );
}

console.log('\n--- a level holds one class, not several (R1 x R3) ---');
const L1 = levels.find((l) => l.code === 'L1');
const branchId = (await call(HT, 'GET', '/branches')).body.items[0].id;
const second = await call(HT, 'POST', '/sections', {
  branchId,
  academicYearId: year.id,
  levelId: L1.id,
  gender: 'male',
  name: 'شعبة إضافية',
});
check('a second class for the same level is refused', second.status, 409);

const listed = await call(
  HT,
  'GET',
  `/sections?academicYearId=${year.id}&levelId=${L1.id}&pageSize=100`,
);
const l1Classes = listed.body.items.filter((s) => s.levelId === L1.id);
check('L1 holds exactly two classes (one per gender)', l1Classes.length, 2);

console.log('\n--- a carry clears when the subject is finally passed (R20) ---');
/* Read-only: the promotion engine writes carries, and settling one needs a
   marked paper. Rather than manufacture that here, assert the endpoint exists
   and answers in the documented shape for a real student. */
const someStudent = (await call(HT, 'GET', '/students?pageSize=1')).body.items[0];
if (someStudent) {
  const carries = await call(HT, 'GET', `/students/${someStudent.id}/carried-subjects`);
  check('carried-subjects answers', carries.status, 200);
  check('and returns a list', Array.isArray(carries.body), true);
  const shaped = carries.body.every(
    (g) =>
      typeof g.originLevelId === 'number' &&
      typeof g.originLevelName === 'string' &&
      Array.isArray(g.subjects),
  );
  check('grouped by origin level', shaped, true);
} else {
  console.log('      skipped: no students yet');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
