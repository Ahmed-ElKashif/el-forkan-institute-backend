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
const stamp = Date.now().toString().slice(-6);
const teacher = (await call(HT, 'POST', '/users', {
  fullName: `شهادات ${stamp}`, username: `c${stamp}`, gender: 'male',
  phone: `0106${stamp}1`, password: 'TeacherPass123', role: 'teacher', branchId: 1,
})).body;
const T = await login(`c${stamp}`, 'TeacherPass123');

// A self-contained year with one graduating student.
const allYears = (await call(HT, 'GET', '/academic-years?pageSize=100')).body.items;
const year = (await call(HT, 'POST', '/academic-years', { hijriYear: Math.max(...allYears.map((y) => y.hijriYear)) + 1 })).body;
const levels = (await call(HT, 'GET', '/levels')).body;
const L4 = levels.find((l) => l.code === 'L4');
const branchId = 1;

const section = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L4.id, gender: 'male', name: `L4-شهادة-${stamp}`,
})).body;
const student = (await call(HT, 'POST', '/students', { fullName: `خريج ${stamp}`, gender: 'male', branchId })).body;
const enrollment = (await call(HT, 'POST', '/enrollments', { studentId: student.id, sectionId: section.id })).body;

// R1: L4 is terminal, so a clean pass there is graduation, not promotion.
await call(HT, 'PUT', `/academic-years/${year.id}/progression-rules`, { levelId: L4.id, maxCarriedSubjects: 3 });
const preview = await call(HT, 'POST', '/promotion/preview', { academicYearId: year.id, levelId: L4.id });
const row = preview.body.find((r) => r.enrollmentId === enrollment.id);
show('L4 with nothing failed', row.decision);
check('a clean terminal level GRADUATES (confirmed by the head teacher)', row.decision, 'graduate');
await call(HT, 'POST', '/promotion/confirm', {
  academicYearId: year.id, levelId: L4.id, enrollmentIds: [enrollment.id],
});

console.log('\n--- issuing ---');
const certifiable = await call(HT, 'GET', `/certificates/certifiable?levelId=${L4.id}`);
check('a graduate is ready to certify (R19)', certifiable.body.some((c) => c.studentId === student.id), true);

const cert = await call(HT, 'POST', '/certificates', { studentId: student.id, levelId: L4.id });
check('issued without having to invent a serial', cert.status, 201);
show('auto-generated serial', cert.body.serialNo);
check('serial is shaped LEVEL-HIJRIYEAR-NNNN', /^L4-\d{4}-\d{4}$/.test(cert.body.serialNo ?? ''), true);

const second = await call(HT, 'POST', '/certificates', { studentId: student.id, levelId: L4.id });
check('a second LIVE certificate is refused', second.status, 409);
show('and the message points at reprint', second.body?.message);
check('...naming the reprint action', second.body?.message?.includes('reprint'), true);

console.log('\n--- reprinting a lost certificate (the common case) ---');
check('teacher cannot reprint (§3)', (await call(T, 'POST', `/certificates/${cert.body.id}/reprint`)).status, 403);
const print1 = await call(HT, 'POST', `/certificates/${cert.body.id}/reprint`);
check('head teacher reprints', print1.status, 201);
show('payload', JSON.stringify({
  serial: print1.body.serialNo, student: print1.body.studentName,
  level: print1.body.levelNameAr, institute: print1.body.instituteNameAr,
  branch: print1.body.branchNameAr, year: print1.body.hijriYear,
  issuedBy: print1.body.issuedByName, copy: print1.body.copyNumber,
}));
check('the serial is UNCHANGED — same certificate, new paper', print1.body.serialNo, cert.body.serialNo);
check('the issue date is unchanged too', print1.body.issuedAt, cert.body.issuedAt);
check('this is copy 2 (the original was copy 1)', print1.body.copyNumber, 2);
check('the payload carries everything a printed page needs',
  [print1.body.studentName, print1.body.levelNameAr, print1.body.instituteNameAr, print1.body.issuedByName].every(Boolean), true);

const print2 = await call(HT, 'POST', `/certificates/${cert.body.id}/reprint`);
check('reprinting again counts up', print2.body.copyNumber, 3);
check('no extra certificate row was created', (await call(HT, 'GET', `/certificates?studentId=${student.id}`)).body.length, 1);

const reprintLog = await call(HT, 'GET', `/audit-logs?action=certificate.reprint&entityId=${cert.body.id}`);
check('every copy is recorded in the audit log', reprintLog.body.total, 2);
show('audit', JSON.stringify(reprintLog.body.items[0].after));

console.log('\n--- re-issuing after revocation ---');
const revoked = await call(HT, 'POST', `/certificates/${cert.body.id}/revoke`, { reason: 'طُبعت بخطأ فى الاسم' });
check('revoke with a reason', revoked.status, 201);
check('a revoked certificate must NOT be reprinted', (await call(HT, 'POST', `/certificates/${cert.body.id}/reprint`)).status, 409);
check('the student is ready to certify again', (await call(HT, 'GET', `/certificates/certifiable?levelId=${L4.id}`)).body.some((c) => c.studentId === student.id), true);

const replacement = await call(HT, 'POST', '/certificates', { studentId: student.id, levelId: L4.id });
check('a replacement CAN now be issued (partial unique index)', replacement.status, 201);
show('replacement serial', replacement.body.serialNo);
check('the replacement gets a NEW serial', replacement.body.serialNo !== cert.body.serialNo, true);
check('the revoked one is kept as history', (await call(HT, 'GET', `/certificates?studentId=${student.id}`)).body.length, 2);
const history = (await call(HT, 'GET', `/certificates?studentId=${student.id}`)).body;
show('history', history.map((c) => `${c.serialNo} ${c.revokedAt ? 'revoked' : 'live'}`).join(' | '));
check('exactly one is live', history.filter((c) => c.revokedAt === null).length, 1);
check('the replacement can be reprinted', (await call(HT, 'POST', `/certificates/${replacement.body.id}/reprint`)).status, 201);
check('a duplicate live certificate is still refused after all that',
  (await call(HT, 'POST', '/certificates', { studentId: student.id, levelId: L4.id })).status, 409);

// §10 item 2 leaves the numbering to the institute, so the generated serial
// must never get in the way of their own convention.
const student2 = (await call(HT, 'POST', '/students', { fullName: `خريج ثان ${stamp}`, gender: 'male', branchId })).body;
const enrollment2 = (await call(HT, 'POST', '/enrollments', { studentId: student2.id, sectionId: section.id })).body;
await call(HT, 'POST', '/promotion/confirm', {
  academicYearId: year.id, levelId: L4.id, enrollmentIds: [enrollment2.id],
});
const custom = await call(HT, 'POST', '/certificates', {
  studentId: student2.id, levelId: L4.id, serialNo: `فرقان/${stamp}/٤`,
});
check('an explicit serial overrides the generated one', custom.status, 201);
check('...and is stored exactly as typed', custom.body.serialNo, `فرقان/${stamp}/٤`);
check('a duplicate serial is refused across the whole table',
  (await call(HT, 'POST', '/certificates', { studentId: student.id, levelId: L4.id, serialNo: `فرقان/${stamp}/٤` })).status, 409);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
