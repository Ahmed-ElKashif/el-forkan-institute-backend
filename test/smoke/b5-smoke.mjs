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
  fullName: `معلم ${stamp}`, username: `x${stamp}`, gender: 'male',
  phone: `0101${stamp}1`, password: 'TeacherPass123', role: 'teacher', branchId: 1,
})).body;
const T = await login(`x${stamp}`, 'TeacherPass123');

const allYears = (await call(HT, 'GET', '/academic-years?pageSize=100')).body.items;
const freshHijri = Math.max(...allYears.map((y) => y.hijriYear)) + 1;
const yearRes = await call(HT, 'POST', '/academic-years', { hijriYear: freshHijri });
if (yearRes.status !== 201) throw new Error('could not create test year: ' + JSON.stringify(yearRes.body));
const year = yearRes.body;
show('test year', `${year.hijriYear} (${year.startsOn} → ${year.endsOn})`);
const term1 = year.terms.find((t) => t.termNumber === 1);
const levels = (await call(HT, 'GET', '/levels')).body;
const L1 = levels.find((l) => l.code === 'L1');
const L4 = levels.find((l) => l.code === 'L4');
const branchId = 1;
const subjects = (await call(HT, 'GET', '/subjects?pageSize=100')).body.items;
const S = (code) => subjects.find((s) => s.code === code);

// --- fixtures: a section, three students, and a curriculum with one
//     إلزامية subject and two optional ones.
const section = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'male', name: `L1-تقييم-${stamp}`,
})).body;
await call(HT, 'POST', `/sections/${section.id}/teachers`, { userId: teacher.id, isPrimary: true });

const students = [];
for (const n of ['ناجح', 'حامل', 'راسب']) {
  const s = (await call(HT, 'POST', '/students', { fullName: `${n} ${stamp}`, gender: 'male', branchId })).body;
  const e = (await call(HT, 'POST', '/enrollments', { studentId: s.id, sectionId: section.id })).body;
  students.push({ name: n, ...s, enrollmentId: e.id });
}

const TERM_NO = 1;
const flatCurriculum = [];
const mkCurriculum = async (code, isMandatory, passScore = 50) => {
  const res = await call(HT, 'POST', `/academic-years/${year.id}/levels/${L1.id}/curriculum`, {
    subjectId: S(code).id, termNumber: TERM_NO, isMandatory, maxScore: 100, passScore,
  });
  if (res.status !== 201) throw new Error(`curriculum ${code}: ${JSON.stringify(res.body)}`);
  return res.body;
};
const aqeedah = await mkCurriculum('AQEEDAH', true);   // إلزامية (R17)
const nahw = await mkCurriculum('USUL_FIQH', false);
const balagha = await mkCurriculum('SEERAH', false);
show('curriculum', `${aqeedah.subjectNameAr}(إلزامية) ${nahw.subjectNameAr} ${balagha.subjectNameAr}`);

await call(HT, 'PUT', `/academic-years/${year.id}/progression-rules`, {
  levelId: L1.id, maxCarriedSubjects: 3, makeupRoundEnabled: false, mandatoryCanBeCarried: false,
});

console.log('\n--- exam scheduling (§4.2) ---');
const term2 = year.terms.find((t) => t.termNumber === TERM_NO);
const mkExam = (curriculumId) =>
  call(HT, 'POST', '/exams', { branchId, termId: term2.id, curriculumId, examType: 'term_1' });
const examAqeedah = await mkExam(aqeedah.id);
check('create an exam against an examinable curriculum row', examAqeedah.status, 201);
check('the exam INHERITS the pass mark from the syllabus', examAqeedah.body.passScore, 50);
check('...and the max score', examAqeedah.body.maxScore, 100);

const container = (await call(HT, 'POST', `/academic-years/${year.id}/levels/${L1.id}/curriculum`, {
  subjectId: S('QURAN_AXIS').id, termNumber: TERM_NO, isExaminable: false,
})).body;
const badExam = await mkExam(container.id);
check('an exam against a CONTAINER row is refused (§4.1)', badExam.status, 409);
show('message', badExam.body?.message);

const examNahw = await mkExam(nahw.id);
const examBalagha = await mkExam(balagha.id);
show('nahw exam', `${examNahw.status} ${JSON.stringify(examNahw.body).slice(0, 160)}`);
show('balagha exam', `${examBalagha.status} ${JSON.stringify(examBalagha.body).slice(0, 160)}`);
show('curriculum ids', `aqeedah=${aqeedah.id} nahw=${nahw.id} balagha=${balagha.id}`);
check('duplicate exam for the same (term, curriculum, gender, type) refused', (await mkExam(nahw.id)).status, 409);

console.log('\n--- eligibility engine (R7 / §4.6) ---');
const elig = await call(HT, 'POST', `/exams/${examAqeedah.body.id}/eligibility/compute`);
check('compute eligibility', elig.status, 201);
show('counts', JSON.stringify(elig.body));
check('all three enrolled students are eligible', elig.body.eligible, 3);
const eligRows = await call(HT, 'GET', `/exams/${examAqeedah.body.id}/eligibility`);
check('every row carries a reason code', eligRows.body.every((r) => r.reasonCode.length > 0), true);
show('reason codes', [...new Set(eligRows.body.map((r) => r.reasonCode))].join(', '));

const target = eligRows.body.find((r) => r.enrollmentId === students[0].enrollmentId) ?? eligRows.body[0];
check('teacher cannot override eligibility (§3)', (await call(T, 'PATCH', `/exam-eligibility/${target.id}`, {
  isEligible: false, reasonNote: 'nope',
})).status, 403);
const override = await call(HT, 'PATCH', `/exam-eligibility/${target.id}`, {
  isEligible: false, reasonNote: 'لم يسدد المصروفات', seatNo: 'A1',
});
check('head teacher overrides with a reason', override.status, 200);
check('the override is labelled as such', override.body.reasonCode, 'manual_override');
await call(HT, 'POST', `/exams/${examAqeedah.body.id}/eligibility/compute`);
const afterRecompute = (await call(HT, 'GET', `/exams/${examAqeedah.body.id}/eligibility`)).body.find((r) => r.id === target.id);
check('recomputing does NOT undo the override', afterRecompute.isEligible, false);
check('...and keeps its reason note', afterRecompute.reasonNote, 'لم يسدد المصروفات');
// put it back so the rest of the run has three candidates
await call(HT, 'PATCH', `/exam-eligibility/${target.id}`, { isEligible: true, reasonNote: 'سدد المصروفات' });

console.log('\n--- score entry & lock (R18, R8) ---');
for (const e of [examAqeedah, examNahw, examBalagha]) {
  await call(HT, 'POST', `/exams/${e.body.id}/eligibility/compute`);
}
const grid = await call(T, 'GET', `/exams/${examAqeedah.body.id}/scores`);
check('teacher loads the score grid', grid.status, 200);
check('one row per eligible student', grid.body.rows.length, 3);
check('grid carries the pass mark', grid.body.passScore, 50);

const byName = (n) => students.find((s) => s.name === n).enrollmentId;
// ناجح passes everything · حامل fails two optional · راسب fails the إلزامية
const scoreSets = [
  [examAqeedah, [['ناجح', 80], ['حامل', 70], ['راسب', 30]]],
  [examNahw,    [['ناجح', 75], ['حامل', 20], ['راسب', 60]]],
  [examBalagha, [['ناجح', 90], ['حامل', 10], ['راسب', 55]]],
];
for (const [exam, marks] of scoreSets) {
  const res = await call(T, 'POST', `/exams/${exam.body.id}/scores`, {
    entries: marks.map(([n, score]) => ({ enrollmentId: byName(n), score })),
  });
  check(`save scores for ${exam.body.subjectNameAr}`, res.status, 201);
}
check('a score above the maximum is refused', (await call(T, 'POST', `/exams/${examNahw.body.id}/scores`, {
  entries: [{ enrollmentId: byName('ناجح'), score: 150 }],
})).status, 400);
check('an absent student with a score is refused', (await call(T, 'POST', `/exams/${examNahw.body.id}/scores`, {
  entries: [{ enrollmentId: byName('ناجح'), score: 50, isAbsent: true }],
})).status, 400);

const scored = await call(T, 'GET', `/exams/${examAqeedah.body.id}/scores`);
const passRow = scored.body.rows.find((r) => r.enrollmentId === byName('ناجح'));
const failRow = scored.body.rows.find((r) => r.enrollmentId === byName('راسب'));
check('80 >= 50 is a pass', passRow.result, 'pass');
check('30 < 50 is a fail', failRow.result, 'fail');

check('teacher cannot lock an exam (§3)', (await call(T, 'POST', `/exams/${examAqeedah.body.id}/lock`)).status, 403);
check('head teacher locks it', (await call(HT, 'POST', `/exams/${examAqeedah.body.id}/lock`)).body.isLocked, true);
check('scores can no longer be saved on a locked exam', (await call(T, 'POST', `/exams/${examAqeedah.body.id}/scores`, {
  entries: [{ enrollmentId: byName('راسب'), score: 99 }],
})).status, 409);

console.log('\n--- R8: correcting a locked grade ---');
check('teacher cannot correct a grade', (await call(T, 'PATCH', `/exam-results/${failRow.resultId}`, {
  score: 99, reason: 'trying it on',
})).status, 403);
check('head teacher needs a reason', (await call(HT, 'PATCH', `/exam-results/${failRow.resultId}`, { score: 55 })).status, 400);
const corrected = await call(HT, 'PATCH', `/exam-results/${failRow.resultId}`, {
  score: 55, reason: 'خطأ فى الرصد — أعيد التصحيح',
});
check('head teacher corrects it WITH a reason', corrected.status, 200);
check('and the result flipped to pass', corrected.body.result, 'pass');
// put it back so the promotion run has a real failure to decide on
await call(HT, 'PATCH', `/exam-results/${failRow.resultId}`, { score: 30, reason: 'أعيد للقيمة الأصلية' });
const changeLog = await call(HT, 'GET', '/audit-logs?action=exam.score.correct&pageSize=5');
check('every correction is audited (R8)', changeLog.body.total >= 2, true);
show('latest', JSON.stringify(changeLog.body.items[0].after));

console.log('\n--- term results (§4.2 weighted totals) ---');
const termResults = await call(HT, 'POST', `/sections/${section.id}/term-results/${term2.id}/compute`);
check('compute term results', termResults.status, 201);
for (const r of termResults.body) show(r.studentName, `${r.totalScore}/${r.maxTotal} = ${r.percentage}% · failed ${r.subjectsFailed} (${r.mandatoryFailed} إلزامية) · ${r.result}`);
const winner = termResults.body.find((r) => r.studentName === `ناجح ${stamp}`);
check('ناجح: (80+75+90)/300', winner.percentage, 81.67);
check('...and failed nothing', winner.subjectsFailed, 0);
const carrier = termResults.body.find((r) => r.studentName === `حامل ${stamp}`);
check('حامل failed the two optional subjects', carrier.subjectsFailed, 2);
check('...none of them إلزامية', carrier.mandatoryFailed, 0);
const failer = termResults.body.find((r) => r.studentName === `راسب ${stamp}`);
check('راسب failed the إلزامية', failer.mandatoryFailed, 1);

const finalized = await call(HT, 'POST', `/sections/${section.id}/term-results/${term2.id}/finalize`);
check('finalise freezes the row', finalized.body[0].finalizedAt !== null, true);

console.log('\n--- promotion run (§4.3, preview → confirm) ---');
const preview = await call(HT, 'POST', '/promotion/preview', { academicYearId: year.id, levelId: L1.id });
check('preview', preview.status, 201);
const rows = preview.body.filter((r) => students.some((s) => s.enrollmentId === r.enrollmentId));
for (const r of rows) show(r.studentName, `${r.decision}  (failed: ${r.failedSubjects.map((f) => f.nameAr).join(', ') || 'none'})`);
check('ناجح is promoted', rows.find((r) => r.studentName === `ناجح ${stamp}`).decision, 'promote');
check('حامل carries 2 (within the limit of 3, R13)', rows.find((r) => r.studentName === `حامل ${stamp}`).decision, 'promote_with_carry');
check('راسب needs a makeup — an إلزامية cannot be carried (R17)', rows.find((r) => r.studentName === `راسب ${stamp}`).decision, 'makeup_required');
check('teacher cannot run promotion (§3)', (await call(T, 'POST', '/promotion/preview', { academicYearId: year.id })).status, 403);
check('preview wrote nothing', (await call(HT, 'GET', `/enrollments?sectionId=${section.id}`)).body.items.every((e) => e.finalDecision === null), true);

// §8 Phase 4: the confirm creates next year's enrolments, so a target year
// with an open L2 section has to exist for anyone to move into.
const nextYearRes = await call(HT, 'POST', '/academic-years', { hijriYear: freshHijri + 1 });
if (nextYearRes.status !== 201) throw new Error('could not create target year: ' + JSON.stringify(nextYearRes.body));
const nextYear = nextYearRes.body;
const L2 = levels.find((l) => l.code === 'L2');
const nextL2 = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: nextYear.id, levelId: L2.id, gender: 'male', name: `L2-${stamp}`,
})).body;

const confirm = await call(HT, 'POST', '/promotion/confirm', {
  academicYearId: year.id, levelId: L1.id, targetAcademicYearId: nextYear.id,
  enrollmentIds: rows.map((r) => r.enrollmentId),
});
check('confirm applies the reviewed decisions', confirm.status, 201);
show('applied', JSON.stringify(confirm.body));
check('next year enrolments created for promote + carry', confirm.body.enrollmentsCreated, 2);
check('two carries written for حامل', confirm.body.carriesWritten, 2);
check('the makeup student was NOT moved forward', confirm.body.notMovedForward, 0);

const nextRoster = (await call(HT, 'GET', `/enrollments?sectionId=${nextL2.id}`)).body.items;
show('next year L2 roster', nextRoster.map((e) => `${e.studentName} (${e.entryType})`).join(' | '));
check('ناجح arrives as promoted', nextRoster.some((e) => e.studentName === `ناجح ${stamp}` && e.entryType === 'promoted'), true);
check('حامل arrives as promoted_with_carry', nextRoster.some((e) => e.studentName === `حامل ${stamp}` && e.entryType === 'promoted_with_carry'), true);
const after = (await call(HT, 'GET', `/enrollments?sectionId=${section.id}`)).body.items;
check('decisions are now stored', after.filter((e) => e.finalDecision !== null).length, 3);

console.log('\n--- COMP entry gate (R20 / §4.4) ---');
const compWinner = await call(HT, 'GET', `/students/${students.find((s) => s.name === 'ناجح').id}/comp-eligibility`);
check('a student who never sat L4 is refused', compWinner.body.allowed, false);
check('...and told why', compWinner.body.refusal, 'no_l4_enrollment');
const compCarrier = await call(HT, 'GET', `/students/${students.find((s) => s.name === 'حامل').id}/comp-eligibility`);
check('a student with pending carries is refused', compCarrier.body.allowed, false);
show('outstanding papers', compCarrier.body.pendingCarries.map((c) => c.nameAr).join(', '));
check('...and the outstanding papers are listed', compCarrier.body.pendingCarries.length, 2);

console.log('\n--- certificates (R19 / §4.5) ---');
const certifiable = await call(HT, 'GET', `/certificates/certifiable?levelId=${L1.id}`);
check('ready-to-certify list', certifiable.status, 200);
const readyNames = certifiable.body.map((c) => c.studentName);
check('ناجح is ready to certify', readyNames.some((n) => n === `ناجح ${stamp}`), true);
check('حامل is NOT ready (promote_with_carry is not promote)', readyNames.some((n) => n === `حامل ${stamp}`), false);

const winnerId = students.find((s) => s.name === 'ناجح').id;
check('teacher cannot issue a certificate (§3)', (await call(T, 'POST', '/certificates', { studentId: winnerId, levelId: L1.id })).status, 403);
const cert = await call(HT, 'POST', '/certificates', { studentId: winnerId, levelId: L1.id, serialNo: `FRQ-${stamp}` });
check('head teacher issues it', cert.status, 201);
show('certificate', `${cert.body.levelCode} serial ${cert.body.serialNo}`);
check('one per student per level', (await call(HT, 'POST', '/certificates', { studentId: winnerId, levelId: L1.id })).status, 409);
check('the certified student drops off the ready list', (await call(HT, `GET`, `/certificates/certifiable?levelId=${L1.id}`)).body.some((c) => c.studentId === winnerId), false);
check('revoking needs a reason', (await call(HT, 'POST', `/certificates/${cert.body.id}/revoke`, {})).status, 400);
const revoked = await call(HT, 'POST', `/certificates/${cert.body.id}/revoke`, { reason: 'صدرت بالخطأ' });
check('revoke with a reason', revoked.status, 201);
check('...and it is recorded', revoked.body.revokeReason, 'صدرت بالخطأ');

console.log('\n--- historical rows are never re-decided (§4.3) ---');
const y1447 = allYears.find((y) => y.hijriYear === 1447);
const historical = (await call(HT, 'POST', '/promotion/preview', { academicYearId: y1447.id })).body
  .filter((r) => r.blocker !== null);
show('blocked rows', historical.length);
check('imported 1447 rows carry a blocker', historical.length > 0, true);
check('...naming why', historical[0]?.blocker?.includes('Historical'), true);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
