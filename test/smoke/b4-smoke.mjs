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
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 200); }
  return { status: res.status, body: parsed };
}
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  ok ? pass++ : fail++;
}
const show = (l, v) => console.log(`      ${l}: ${v}`);
const login = async (u, p) =>
  (await call(null, 'POST', '/auth/login', { username: u, password: p })).body.accessToken;

const HT = await login('headteacher', 'ChangeMe123!');
const stamp = Date.now().toString().slice(-6);

// A fresh teacher per run. Timetable clash detection is global to a teacher
// across every section, so reusing one would (correctly) clash with the slots
// left behind by the previous run.
const teacher = (await call(HT, 'POST', '/users', {
  fullName: `معلمة ${stamp}`, username: `t${stamp}`, gender: 'female',
  phone: `0100${stamp}1`, password: 'TeacherPass123', role: 'teacher', branchId: 1,
})).body;
const T = await login(`t${stamp}`, 'TeacherPass123');

const year = (await call(HT, 'GET', '/academic-years')).body.items.find((y) => y.hijriYear === 1447);
const term1 = year.terms.find((t) => t.termNumber === 1);
const levels = (await call(HT, 'GET', '/levels')).body;
const L1 = levels.find((l) => l.code === 'L1');
const branchId = (await call(HT, 'GET', '/branches')).body.items[0].id;
const subjects = (await call(HT, 'GET', '/subjects?pageSize=100')).body.items;
const nahw = subjects.find((s) => s.code === 'NAHW');
const fiqh = subjects.find((s) => s.code === 'FIQH');
const saraId = teacher.id;

// A fresh female section that sara teaches, so both the head teacher and the
// teacher paths can be exercised.
const section = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'female', name: `L1-تدريس-${stamp}`,
})).body;
await call(HT, 'POST', `/sections/${section.id}/teachers`, { userId: saraId, isPrimary: true });

// Three female students on the roster.
const students = [];
for (const n of ['أ', 'ب', 'ج']) {
  const s = (await call(HT, 'POST', '/students', {
    fullName: `طالبة ${n} ${stamp}`, gender: 'female', branchId,
  })).body;
  const e = (await call(HT, 'POST', '/enrollments', { studentId: s.id, sectionId: section.id })).body;
  students.push({ ...s, enrollmentId: e.id });
}
show('roster', students.map((s) => s.fullName).join(' | '));

console.log('\n--- timetable & clash detection (§8 Phase 3) ---');
const slot1 = await call(HT, 'POST', `/sections/${section.id}/timetable`, {
  subjectId: nahw.id, teacherId: saraId, weekday: 5, slotOrder: 1, startsAt: '09:00', endsAt: '10:30',
});
check('create a Friday slot', slot1.status, 201);
check('teacher cannot set the timetable (§3)', (await call(T, 'POST', `/sections/${section.id}/timetable`, {
  subjectId: fiqh.id, slotOrder: 2, startsAt: '11:00', endsAt: '12:00',
})).status, 403);
check('teacher CAN read the timetable of their own section', (await call(T, 'GET', `/sections/${section.id}/timetable`)).status, 200);

const clash = await call(HT, 'POST', `/sections/${section.id}/timetable`, {
  subjectId: fiqh.id, teacherId: saraId, weekday: 5, slotOrder: 2, startsAt: '10:00', endsAt: '11:00',
});
check('overlapping slot for the SAME teacher is refused', clash.status, 409);
show('message', clash.body?.message?.slice(0, 90));

const backToBack = await call(HT, 'POST', `/sections/${section.id}/timetable`, {
  subjectId: fiqh.id, teacherId: saraId, weekday: 5, slotOrder: 2, startsAt: '10:30', endsAt: '12:00',
});
check('back-to-back slot is allowed (touching endpoints do not clash)', backToBack.status, 201);
check('endsAt before startsAt refused', (await call(HT, 'POST', `/sections/${section.id}/timetable`, {
  subjectId: fiqh.id, weekday: 3, slotOrder: 9, startsAt: '12:00', endsAt: '09:00',
})).status, 400);

console.log('\n--- session generation ---');
const gen = await call(HT, 'POST', `/sections/${section.id}/sessions/generate`, { termId: term1.id });
check('generate sessions', gen.status, 201);
show('generated', `${gen.body.created} created, ${gen.body.skipped} already existed`);
check('15 per slot × 2 slots = 30 (institute_settings.sessions_per_term)', gen.body.created, 30);

const rerun = await call(HT, 'POST', `/sections/${section.id}/sessions/generate`, { termId: term1.id });
check('re-running creates nothing (unique constraint = idempotency)', rerun.body.created, 0);
check('...and reports them as skipped', rerun.body.skipped, 30);

const sessions = await call(HT, 'GET', `/sessions?sectionId=${section.id}&pageSize=100`);
check('sessions listed', sessions.status, 200);
const firstSession = sessions.body.items[0];
show('first session', `${firstSession.sessionDate} ${firstSession.startsAt}-${firstSession.endsAt} ${firstSession.subjectNameAr} (no. ${firstSession.sessionNo})`);
check('first session falls on the term start (a Friday)', firstSession.sessionDate, term1.startsOn);
check('teacher sees the sessions of their own section', (await call(T, `GET`, `/sessions?sectionId=${section.id}`)).body.total > 0, true);

console.log('\n--- session exceptions (R4) ---');
check('switching to online without a URL is refused', (await call(HT, 'PATCH', `/sessions/${firstSession.id}`, { mode: 'online' })).status, 400);
const online = await call(HT, 'PATCH', `/sessions/${firstSession.id}`, { mode: 'online', meetingUrl: 'https://meet.example.test/abc' });
check('switching to online WITH a URL works', online.status, 200);
check('the moved/re-moded session is flagged as an exception', online.body.isException, true);
check('cancelling without a reason is refused', (await call(HT, 'PATCH', `/sessions/${firstSession.id}`, { status: 'cancelled' })).status, 400);

console.log('\n--- attendance grid (§8 Phase 3) ---');
const grid = await call(T, 'GET', `/sections/${section.id}/attendance?termId=${term1.id}`);
check('teacher loads the grid', grid.status, 200);
check('one row per enrolled student', grid.body.rows.length, 3);
check('one cell per session, in every row', grid.body.rows.every((r) => r.cells.length === grid.body.sessions.length), true);
show('grid', `${grid.body.rows.length} students × ${grid.body.sessions.length} sessions`);
check('cells start empty', grid.body.rows[0].cells.every((c) => c.status === null), true);

const targetSession = grid.body.sessions[1].id;
const save = await call(T, 'POST', `/sessions/${targetSession}/attendance`, {
  entries: [
    { enrollmentId: students[0].enrollmentId, status: 'present', attendedMode: 'onsite' },
    { enrollmentId: students[1].enrollmentId, status: 'absent' },
    { enrollmentId: students[2].enrollmentId, status: 'late', minutesLate: 10 },
  ],
});
check('save a whole column in one request', save.status, 200);
check('all three recorded', save.body.saved, 3);
check('an absent student with an attendance mode is refused', (await call(T, 'POST', `/sessions/${targetSession}/attendance`, {
  entries: [{ enrollmentId: students[1].enrollmentId, status: 'absent', attendedMode: 'online' }],
})).status, 400);

const resaved = await call(T, 'POST', `/sessions/${targetSession}/attendance`, {
  entries: [{ enrollmentId: students[1].enrollmentId, status: 'present', attendedMode: 'online' }],
});
check('re-saving a correction overwrites rather than duplicating', resaved.status, 200);
const grid2 = await call(T, 'GET', `/sections/${section.id}/attendance?termId=${term1.id}`);
const correctedRow = grid2.body.rows.find((r) => r.enrollmentId === students[1].enrollmentId);
check('the correction stuck', correctedRow.cells.find((c) => c.sessionId === targetSession).status, 'present');
check('R4: a student attended a session online', correctedRow.cells.find((c) => c.sessionId === targetSession).attendedMode, 'online');

console.log('\n--- absence thresholds (§4.8) ---');
await call(HT, 'PUT', `/academic-years/${year.id}/attendance-policies`, {
  levelId: L1.id, maxAbsences: 3, warnAtAbsences: 2, exceedingAction: 'block_exam',
});
const victim = students[2].enrollmentId;
let lastWarnings = [];
for (let i = 2; i <= 5; i += 1) {
  const res = await call(T, 'POST', `/sessions/${grid.body.sessions[i].id}/attendance`, {
    entries: [{ enrollmentId: victim, status: 'absent' }],
  });
  lastWarnings = res.body.warnings;
  show(`after absence ${i - 1}`, JSON.stringify(res.body.warnings.map((w) => ({ n: w.absenceCount, at: w.threshold, blocks: w.blocksExams }))));
}
check('a warning fired once the threshold was crossed', lastWarnings.length > 0, true);
check('the highest threshold reached is reported, not every one', lastWarnings[0]?.threshold, 3);
check('and it blocks exams (exceeding_action = block_exam)', lastWarnings[0]?.blocksExams, true);

const warned = (await call(HT, 'GET', `/sections/${section.id}/attendance?termId=${term1.id}`)).body
  .rows.find((r) => r.enrollmentId === victim);
show('absence count on the grid', warned.absenceCount);
check('absences counted on the grid', warned.absenceCount >= 3, true);

console.log('\n--- scoping still holds ---');
const otherSection = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'male', name: `L1-اخرى-${stamp}`,
})).body;
check('teacher gets 403 on another section grid', (await call(T, 'GET', `/sections/${otherSection.id}/attendance?termId=${term1.id}`)).status, 403);
check('teacher gets 403 on its timetable', (await call(T, 'GET', `/sections/${otherSection.id}/timetable`)).status, 403);
check('head teacher reads it fine', (await call(HT, 'GET', `/sections/${otherSection.id}/timetable`)).status, 200);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
