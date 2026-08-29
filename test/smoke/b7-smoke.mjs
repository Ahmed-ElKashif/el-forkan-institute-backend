const API = 'http://localhost:3000';
let pass = 0, fail = 0;
async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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
const login = async (u, p) => (await call(null, 'POST', '/auth/login', { username: u, password: p })).body.accessToken;

const HT = await login('headteacher', 'ChangeMe123!');
const y1447 = (await call(HT, 'GET', '/academic-years?pageSize=100')).body.items.find((y) => y.hijriYear === 1447);
const term1 = y1447.terms.find((t) => t.termNumber === 1);

console.log('\n--- dashboard summary ---');
const summary = await call(HT, 'GET', `/reports/summary?academicYearId=${y1447.id}`);
check('summary', summary.status, 200);
show('1447', JSON.stringify(summary.body));
check('reports the Hijri year', summary.body.hijriYear, 1447);
check('counts active enrolments', summary.body.enrollments > 0, true);
check('reports phone coverage as a percentage', typeof summary.body.students.phoneCoverage, 'number');

console.log('\n--- headcount by level x gender (R3) ---');
const byLevel = await call(HT, 'GET', `/reports/headcount-by-level?academicYearId=${y1447.id}`);
check('headcount', byLevel.status, 200);
check('one row per level (R1)', byLevel.body.length, 6);
for (const row of byLevel.body.filter((r) => r.total > 0)) {
  show(row.levelCode, `${row.nameAr ?? row.levelNameAr}: ${row.male} إخوة + ${row.female} أخوات = ${row.total}`);
}
check('male + female always equals the total', byLevel.body.every((r) => r.male + r.female === r.total), true);
check('levels come back in R1 order', byLevel.body.map((r) => r.levelCode).join(','), 'PREP,L1,L2,L3,L4,COMP');

console.log('\n--- headcount by markaz (§6.4) ---');
const byMarkaz = await call(HT, 'GET', `/reports/headcount-by-markaz?academicYearId=${y1447.id}`);
check('markaz breakdown', byMarkaz.status, 200);
for (const row of byMarkaz.body) show(row.markazNameAr, row.count);
check('the "no markaz recorded" bucket is counted, not zeroed',
  byMarkaz.body.filter((r) => r.markazId === null).every((r) => r.count > 0), true);
check('sorted by size, largest first',
  byMarkaz.body.every((r, i, a) => i === 0 || a[i - 1].count >= r.count), true);

console.log('\n--- attendance trend (§8 Phase 6) ---');
const trend = await call(HT, 'GET', `/reports/attendance-trend?termId=${term1.id}`);
check('attendance trend', trend.status, 200);
show('points', trend.body.length);
for (const p of trend.body.slice(0, 3)) show(p.sessionDate, `${p.present}P ${p.absent}A ${p.late}L → ${p.attendanceRate}%`);
check('every rate is a percentage', trend.body.every((p) => p.attendanceRate >= 0 && p.attendanceRate <= 100), true);

console.log('\n--- pass rates (R14: counted at the leaf) ---');
const years = (await call(HT, 'GET', '/academic-years?pageSize=100')).body.items;
let rates = { body: [] };
for (const y of years) {
  const r = await call(HT, 'GET', `/reports/pass-rates?academicYearId=${y.id}`);
  if (r.body.length > 0) { rates = r; show('year with results', y.hijriYear); break; }
}
check('pass rates', rates.body.length > 0, true);
for (const row of rates.body) show(`${row.levelCode} ${row.subjectNameAr}`, `${row.passed}/${row.sat} passed = ${row.passRate}%`);
check('sat = passed + failed + absent', rates.body.every((r) => r.sat === r.passed + r.failed + r.absent), true);
check('every rate is a percentage', rates.body.every((r) => r.passRate >= 0 && r.passRate <= 100), true);

console.log('\n--- scoping (§9: a teacher sees their own sections only) ---');
const stamp = Date.now().toString().slice(-6);
const t = (await call(HT, 'POST', '/users', {
  fullName: `مراقب ${stamp}`, username: `r${stamp}`, gender: 'male',
  phone: `0105${stamp}1`, password: 'TeacherPass123', role: 'teacher', branchId: 1,
})).body;
const T = await login(`r${stamp}`, 'TeacherPass123');
const teacherSummary = await call(T, 'GET', `/reports/summary?academicYearId=${y1447.id}`);
check('a teacher can open the dashboard', teacherSummary.status, 200);
check('...but with no sections assigned, it shows nothing', teacherSummary.body.enrollments, 0);
show('teacher sees', JSON.stringify(teacherSummary.body.students));
check('head teacher sees more than the unassigned teacher', summary.body.enrollments > teacherSummary.body.enrollments, true);
check('teacher headcount is all zeros', (await call(T, 'GET', `/reports/headcount-by-level?academicYearId=${y1447.id}`)).body.every((r) => r.total === 0), true);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
