import { createRequire } from 'module';
const require_ = createRequire('file:///d:/SASA/El Forkan Project/Project/backend/');
const ExcelJS = require_('exceljs');

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
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  ok ? pass++ : fail++;
}
const show = (l, v) => console.log(`      ${l}: ${v}`);

const login = async (u, p) =>
  (await call(null, 'POST', '/auth/login', { username: u, password: p })).body.accessToken;

const HT = await login('headteacher', 'ChangeMe123!');
const T = await login('sara.arabic', 'TeacherPass123');

// ---------------------------------------------------------------- fixtures
const year = (await call(HT, 'GET', '/academic-years')).body.items.find((y) => y.hijriYear === 1447);
const levels = (await call(HT, 'GET', '/levels')).body;
const L1 = levels.find((l) => l.code === 'L1');
const branchId = (await call(HT, 'GET', '/branches')).body.items[0].id;
const stamp = Date.now().toString().slice(-6);

console.log('\n--- sections & the gender guard (R3) ---');
const maleSection = await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'male', name: `L1-إخوة-${stamp}`,
});
check('create male section', maleSection.status, 201);
const femaleSection = await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'female', name: `L1-أخوات-${stamp}`,
});
check('create female section', femaleSection.status, 201);
check('teacher cannot create a section', (await call(T, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'male', name: 'nope',
})).status, 403);

// sara.arabic is female
const saraId = (await call(HT, 'GET', '/users?search=sara.arabic')).body.items[0].id;
const goodAssign = await call(HT, 'POST', `/sections/${femaleSection.body.id}/teachers`, { userId: saraId, isPrimary: true });
check('assign female teacher to female section', goodAssign.status, 201);
const badAssign = await call(HT, 'POST', `/sections/${maleSection.body.id}/teachers`, { userId: saraId });
check('female teacher REFUSED on male section (R3, DB-enforced)', badAssign.status, 409);
show('message', badAssign.body?.message);

console.log('\n--- students ---');
const male = await call(HT, 'POST', '/students', {
  fullName: `طالب اختبار ${stamp}`, gender: 'male', branchId, phone: '01011112222', nationalId: '29801011234567',
});
check('create male student', male.status, 201);
check('national ID not returned in the record', male.body.nationalId, undefined);
check('but its presence is flagged', male.body.hasNationalId, true);
show('generated student code', male.body.studentCode);

const nid = await call(HT, 'GET', `/students/${male.body.id}/national-id`);
check('head teacher can reveal the national ID', nid.status, 200);
check('decrypted value round-trips', nid.body.nationalId, '29801011234567');
check('teacher CANNOT reveal a national ID', (await call(T, 'GET', `/students/${male.body.id}/national-id`)).status, 403);
check('invalid phone rejected', (await call(HT, 'POST', '/students', { fullName: 'x y', gender: 'male', phone: '0100' })).status, 400);
check('invalid national ID rejected', (await call(HT, 'POST', '/students', { fullName: 'x y', gender: 'male', nationalId: '123' })).status, 400);

const female = await call(HT, 'POST', '/students', { fullName: `طالبة اختبار ${stamp}`, gender: 'female', branchId });
check('create female student (names-only, as the real rosters are)', female.status, 201);

console.log('\n--- enrollments & the composite FK ---');
const goodEnroll = await call(HT, 'POST', '/enrollments', { studentId: male.body.id, sectionId: maleSection.body.id });
check('enrol male student in male section', goodEnroll.status, 201);
const badEnroll = await call(HT, 'POST', '/enrollments', { studentId: female.body.id, sectionId: maleSection.body.id });
check('female student REFUSED on male roster (R3, DB-enforced)', badEnroll.status, 409);
show('message', badEnroll.body?.message);
check('same student twice in one year refused', (await call(HT, 'POST', '/enrollments', { studentId: male.body.id, sectionId: maleSection.body.id })).status, 409);

console.log('\n--- section scoping (spec §9: teacher A cannot read section B) ---');
const teacherSections = await call(T, 'GET', '/sections');
// Repeated smoke runs assign this teacher to several sections, so the real
// assertion is that every section returned is one she is actually assigned to.
check('every section the teacher sees is one she is assigned to',
  teacherSections.body.items.length > 0 && teacherSections.body.items.every((s) => s.teachers.some((t) => t.userId === saraId)), true);
check('the new female section is among them', teacherSections.body.items.some((s) => s.id === femaleSection.body.id), true);
check('no male section is ever returned to her (R3 + scoping)', teacherSections.body.items.every((s) => s.gender === 'female'), true);
show('teacher sees', teacherSections.body.items.map((s) => s.name).join(', ') || '(none)');
check('head teacher sees more sections than the teacher', (await call(HT, 'GET', '/sections')).body.total > teacherSections.body.total, true);
check('teacher gets 403 on a section that is not theirs', (await call(T, 'GET', `/sections/${maleSection.body.id}`)).status, 403);
check('teacher gets 403 on its phone coverage too', (await call(T, 'GET', `/sections/${maleSection.body.id}/phone-coverage`)).status, 403);
check('head teacher reads it fine', (await call(HT, 'GET', `/sections/${maleSection.body.id}`)).status, 200);

const coverage = await call(HT, 'GET', `/sections/${maleSection.body.id}/phone-coverage`);
check('phone coverage computed (§6.4)', coverage.status, 200);
show('coverage', `${coverage.body.withPhone}/${coverage.body.total} = ${coverage.body.percentage}%`);

console.log('\n--- placement (§4.7, both routes) ---');
check('entrance exam needs a score', (await call(HT, 'POST', `/students/${male.body.id}/placements`, {
  method: 'entrance_exam', placedLevelId: L1.id,
})).status, 400);
const exam = await call(HT, 'POST', `/students/${male.body.id}/placements`, {
  method: 'entrance_exam', placedLevelId: L1.id, score: 80, maxScore: 100, passScore: 50,
});
check('entrance exam recorded', exam.status, 201);
check('pass decided from the score', exam.body.isPassed, true);
check('recommendation needs a named teacher', (await call(HT, 'POST', `/students/${female.body.id}/placements`, {
  method: 'recommendation', placedLevelId: L1.id,
})).status, 400);
const rec = await call(HT, 'POST', `/students/${female.body.id}/placements`, {
  method: 'recommendation', placedLevelId: L1.id, recommendedBy: saraId,
});
check('recommendation recorded', rec.status, 201);
check('recommendation has no invented pass flag', rec.body.isPassed, null);

console.log('\n--- Excel import: preview → fix → commit (§6.3) ---');
// A roster shaped like the real files, deliberately starting at column F (the
// PREP layout) to prove header-text mapping.
async function buildRoster(rows, startColumn) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('إخوة');
  ws.getCell(1, 1).value = 'دورات الفرقان التثقيفية';
  ws.getCell(2, 1).value = 'فرع أسوان';
  ws.getCell(3, 1).value = '2026 / 1447';
  ['م', 'الأسم', 'المركز', 'رقم الهاتف'].forEach((h, i) => { ws.getCell(4, startColumn + i).value = h; });
  rows.forEach((r, ri) => r.forEach((v, ci) => { ws.getCell(6 + ri, startColumn + ci).value = v; }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const rosterBuffer = await buildRoster([
  ['1', `أحمد الاختبار ${stamp}`, 'إدفو', '01033334444'],
  ['2', `محمود الاختبار ${stamp}`, '', ''],
  ['3', '', '', ''],
  ['4', `طالب اختبار ${stamp}`, '', '01055556666'],
], 6);

async function upload(buffer, fields) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'كشف_أسماء.xlsx');
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  const res = await fetch(API + '/imports', { method: 'POST', headers: { Authorization: 'Bearer ' + HT }, body: form });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

const job = await upload(rosterBuffer, {
  importType: 'roster', branchId, academicYearId: year.id, maleSectionId: maleSection.body.id, isHistorical: 'true',
});
check('preview accepted a PREP-layout file (columns start at F)', job.status, 201);
show('counts', JSON.stringify(job.body.countsByAction));
check('two new students to create', job.body.countsByAction.create, 2);
check('the already-known student is skipped, not duplicated', job.body.countsByAction.skip >= 1, true);
check('the nameless row is an error', job.body.countsByAction.error, 1);
check('NOTHING was written yet (preview only)', (await call(HT, 'GET', `/students?search=أحمد الاختبار ${stamp}`)).body.total, 0);

const rows = await call(HT, 'GET', `/imports/${job.body.id}/rows?pageSize=50`);
const errorRow = rows.body.items.find((r) => r.action === 'error');
show('error row', `row ${errorRow.rowNumber}: ${errorRow.errorMessage}`);

const other = await call(HT, 'POST', '/academic-years', { hijriYear: 1449 });
const otherYearId = other.status === 201 ? other.body.id
  : (await call(HT, 'GET', '/academic-years')).body.items.find((y) => y.hijriYear === 1449).id;
const mismatched = await upload(rosterBuffer, { importType: 'roster', branchId, academicYearId: otherYearId, maleSectionId: maleSection.body.id });
check('a 1447 file imported into 1449 is rejected (§6.2: trust the header, not the filename)', mismatched.status, 400);
show('message', mismatched.body?.message);
check('a year id that does not exist is a 404', (await upload(rosterBuffer, { importType: 'roster', branchId, academicYearId: 9999, maleSectionId: maleSection.body.id })).status, 404);

const committed = await call(HT, 'POST', `/imports/${job.body.id}/commit`, {
  importType: 'roster', branchId, academicYearId: year.id, maleSectionId: maleSection.body.id, isHistorical: 'true',
});
check('commit applied', committed.status, 201);
check('students now exist', (await call(HT, 'GET', `/students?search=أحمد الاختبار ${stamp}`)).body.total, 1);
const enrolled = await call(HT, 'GET', `/enrollments?sectionId=${maleSection.body.id}`);
show('section roster after import', enrolled.body.items.map((e) => e.studentName).join(' | '));
check('imported rows are marked historical (§6.4)', enrolled.body.items.every((e) => e.isHistorical || e.studentName.startsWith('طالب')), true);
check('committing twice is refused', (await call(HT, 'POST', `/imports/${job.body.id}/commit`, {
  importType: 'roster', branchId, academicYearId: year.id, maleSectionId: maleSection.body.id,
})).status, 409);

console.log('\n--- Excel export (§6.5) ---');
const exportRes = await fetch(`${API}/exports/roster?academicYearId=${year.id}&levelId=${L1.id}`, {
  headers: { Authorization: 'Bearer ' + HT },
});
check('roster export returns a workbook', exportRes.status, 200);
check('content type is xlsx', exportRes.headers.get('content-type')?.includes('spreadsheetml'), true);
const exported = Buffer.from(await exportRes.arrayBuffer());
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(exported);
check('two sheets, one per gender (R3)', wb.worksheets.map((w) => w.name).join(','), 'إخوة,أخوات');
check('header block in rows 1-3', wb.worksheets[0].getCell(1, 1).value, 'دورات الفرقان التثقيفية');
check('data starts at row 6', typeof wb.worksheets[0].getCell(6, 2).value, 'string');
show('first exported row', [1, 2, 3, 4].map((c) => wb.worksheets[0].getCell(6, c).value).join(' | '));
const phoneCell = String(wb.worksheets[0].getCell(6, 4).value ?? '');
check('E.164 phone is CSV-injection guarded', phoneCell === '' || phoneCell.startsWith("'"), true);

const auditExport = await call(HT, 'GET', '/audit-logs?action=export.roster');
check('export logged with a row count (§9)', auditExport.body.total > 0, true);
show('audit', JSON.stringify(auditExport.body.items[0]?.after));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
