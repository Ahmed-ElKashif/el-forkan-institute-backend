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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
  ok ? pass++ : fail++;
}

function show(label, value) {
  console.log(`      ${label}: ${value}`);
}

const login = async (u, p) =>
  (await call(null, 'POST', '/auth/login', { username: u, password: p })).body
    .accessToken;

const HT = await login('headteacher', 'ChangeMe123!');
const T = await login('sara.arabic', 'TeacherPass123');

console.log('\n--- geography ---');
// Reference data is institute-wide: created on the first run, reused after.
// A 409 here IS the correct answer, so the assertion is on the outcome.
const gov = await call(HT, 'POST', '/governorates', { nameAr: 'أسوان', nameEn: 'Aswan' });
check('governorate exists (created or already there)', [201, 409].includes(gov.status), true);
const govId = gov.status === 201 ? gov.body.id
  : (await call(HT, 'GET', '/governorates?pageSize=100')).body.items.find((g) => g.nameAr === 'أسوان').id;

const markaz = await call(HT, 'POST', '/markazes', { governorateId: govId, nameAr: 'مركز إدفو' });
check('markaz exists (created or already there)', [201, 409].includes(markaz.status), true);
check('a duplicate markaz in the same governorate is refused',
  (await call(HT, 'POST', '/markazes', { governorateId: govId, nameAr: 'مركز إدفو' })).status, 409);
check('teacher cannot create a markaz', (await call(T, 'POST', '/markazes', { governorateId: govId, nameAr: 'x' })).status, 403);
check('teacher CAN read markazes', (await call(T, 'GET', '/markazes')).status, 200);

console.log('\n--- catalogue ---');
const levels = await call(HT, 'GET', '/levels');
check('six levels seeded (R1)', levels.body.length, 6);
show('levels', levels.body.map((l) => `${l.code}:${l.nameAr}`).join(' '));
const prep = levels.body.find((l) => l.code === 'PREP');
const l1 = levels.body.find((l) => l.code === 'L1');
const comp = levels.body.find((l) => l.code === 'COMP');
check('PREP has no carry (R15)', prep.allowsCarry, false);
check('L4 is terminal (R1)', levels.body.find((l) => l.code === 'L4').isTerminal, true);
check('COMP requires clean entry (R20)', comp.requiresCleanEntry, true);

const subjects = await call(HT, 'GET', '/subjects?pageSize=100');
check('subjects seeded', subjects.body.total >= 18, true);
const arabic = subjects.body.items.find((s) => s.code === 'ARABIC');
const nahw = subjects.body.items.find((s) => s.code === 'NAHW');
const balagha = subjects.body.items.find((s) => s.code === 'BALAGHA');
const fiqh = subjects.body.items.find((s) => s.code === 'FIQH');
show('اللغة العربية aliases', JSON.stringify(arabic.aliases.map((a) => a.aliasAr)));

const seerahId = subjects.body.items.find((s) => s.code === 'SEERAH').id;
const aliasText = `السيرة النبوية ${Date.now().toString().slice(-5)}`;
const alias = await call(HT, 'POST', `/subjects/${seerahId}/aliases`, { aliasAr: aliasText });
check('add alias', alias.status, 201);
show('normalized key', alias.body.normalized);
check('alias was normalised (ة→ه)', alias.body.normalized.startsWith('السيره النبويه'), true);
check('duplicate normalised alias rejected',
  (await call(HT, 'POST', `/subjects/${seerahId}/aliases`, { aliasAr: aliasText.replace('السيرة', 'السيره') })).status, 409);
await call(HT, 'DELETE', `/subject-aliases/${alias.body.id}`);

console.log('\n--- academic year (Hijri generation, §7.5) ---');
const existing = await call(HT, 'GET', '/academic-years');
for (const y of existing.body.items) show('existing year', y.hijriYear);
const year = await call(HT, 'POST', '/academic-years', { hijriYear: 1447 });
const yearBody = year.status === 201 ? year.body : existing.body.items.find((y) => y.hijriYear === 1447);
check('academic year exists', yearBody !== undefined, true);
show('1447 runs', `${yearBody.startsOn} → ${yearBody.endsOn}`);
check('starts 15 Shawwal 1447 = 2026-04-03', yearBody.startsOn, '2026-04-03');
check('ends 15 Shaban 1448 = 2027-01-23', yearBody.endsOn, '2027-01-23');
check('two terms generated (R6)', yearBody.terms.length, 2);
for (const t of yearBody.terms) show(`term ${t.termNumber}`, `${t.startsOn} → ${t.endsOn}, exams ${t.examStartsOn} → ${t.examEndsOn}`);
check('duplicate hijri year rejected', (await call(HT, 'POST', '/academic-years', { hijriYear: 1447 })).status, 409);
check('inverted date range rejected', (await call(HT, 'POST', '/academic-years', { hijriYear: 1449, startsOn: '2026-05-01', endsOn: '2026-04-01' })).status, 400);

console.log('\n--- curriculum builder (§4.1 nesting) ---');
// Curriculum is UNIQUE (year, level, subject, term), so the nesting checks
// get their own year rather than colliding with a previous run's rows.
const allYearsB1 = (await call(HT, `GET`, `/academic-years?pageSize=100`)).body.items;
const curriculumYear = (await call(HT, `POST`, `/academic-years`, {
  hijriYear: Math.max(...allYearsB1.map((y) => y.hijriYear)) + 1,
})).body;
show(`curriculum test year`, curriculumYear.hijriYear);
const yearId = curriculumYear.id;
const mk = (levelId, body) => call(HT, 'POST', `/academic-years/${yearId}/levels/${levelId}/curriculum`, body);

const parent = await mk(l1.id, { subjectId: arabic.id, termNumber: 1, isExaminable: false, teachingOrder: 1 });
check('create container subject (اللغة العربية)', parent.status, 201);
const parentId = parent.body?.id;

const child1 = await mk(l1.id, { subjectId: nahw.id, termNumber: 1, parentCurriculumId: parentId, isMandatory: true, maxScore: 100, passScore: 60 });
check('create child النحو under it', child1.status, 201);
const child2 = await mk(l1.id, { subjectId: balagha.id, termNumber: 1, parentCurriculumId: parentId });
check('create child البلاغة', child2.status, 201);

const deep = await mk(l1.id, { subjectId: fiqh.id, termNumber: 1, parentCurriculumId: child1.body?.id });
check('THREE levels of nesting rejected (depth cap 2)', deep.status, 400);
show('message', deep.body?.message);

const examinableParent = await mk(l1.id, { subjectId: fiqh.id, termNumber: 1, isExaminable: true });
check('create examinable standalone الفقه', examinableParent.status, 201);
const underExaminable = await mk(l1.id, { subjectId: subjects.body.items.find((s) => s.code === 'TAJWEED').id, termNumber: 1, parentCurriculumId: examinableParent.body?.id });
check('child under an EXAMINABLE parent rejected (§4.1 containers)', underExaminable.status, 400);
show('message', underExaminable.body?.message);

check('passScore above maxScore rejected (R18)', (await mk(l1.id, { subjectId: subjects.body.items.find((s) => s.code === 'HIFZ').id, termNumber: 2, maxScore: 50, passScore: 80 })).status, 400);

const unit = await call(HT, 'POST', `/curriculum/${child1.body?.id}/units`, { syllabusScopeAr: 'من الوقف حتى ما قبل الصَّداق', sortOrder: 1 });
check('add curriculum unit (syllabus scope)', unit.status, 201);

const tree = await call(HT, 'GET', `/academic-years/${yearId}/curriculum?levelId=${l1.id}&termNumber=1`);
check('tree read', tree.status, 200);
const arabicNode = tree.body.find((n) => n.id === parentId);
show('tree roots', tree.body.map((n) => `${n.subjectNameAr}(${n.children.length})`).join(' '));
check('اللغة العربية has 2 children', arabicNode?.children.length, 2);
check('child carries its own pass mark', arabicNode?.children[0].passScore, 60);
check('scores are numbers not Decimal objects', typeof arabicNode?.children[0].maxScore, 'number');
check('teacher can READ the curriculum', (await call(T, 'GET', `/academic-years/${yearId}/curriculum`)).status, 200);
check('teacher cannot WRITE the curriculum (R12)', (await call(T, 'POST', `/academic-years/${yearId}/levels/${l1.id}/curriculum`, { subjectId: fiqh.id, termNumber: 2 })).status, 403);
check('deleting a parent with children rejected', (await call(HT, 'DELETE', `/curriculum/${parentId}`)).status, 400);

console.log('\n--- progression rules & attendance policies ---');
const rule = await call(HT, 'PUT', `/academic-years/${yearId}/progression-rules`, { levelId: null, maxCarriedSubjects: 3 });
check('upsert year-wide fallback rule (level_id NULL)', rule.status, 200);
check('carry limit seeded at 3 (R13)', rule.body.maxCarriedSubjects, 3);
check('mandatory cannot be carried by default (R17)', rule.body.mandatoryCanBeCarried, false);
check('failures counted at the leaf (R14)', rule.body.failureCountingUnit, 'leaf');
await call(HT, 'PUT', `/academic-years/${yearId}/progression-rules`, { levelId: null, maxCarriedSubjects: 4 });
await call(HT, 'PUT', `/academic-years/${yearId}/progression-rules`, { levelId: null, maxCarriedSubjects: 3 });
const rules = await call(HT, 'GET', `/academic-years/${yearId}/progression-rules`);
check('repeated NULL-level upsert did NOT duplicate the row', rules.body.filter((r) => r.levelId === null).length, 1);

const prepRule = await call(HT, 'PUT', `/academic-years/${yearId}/progression-rules`, { levelId: prep.id, maxCarriedSubjects: 0, carryForwardEnabled: false });
check('per-level rule for PREP (R15)', prepRule.status, 200);
check('both rules stored — the year fallback and the PREP override',
  (await call(HT, 'GET', `/academic-years/${yearId}/progression-rules`)).body.length, 2);

const policy = await call(HT, 'PUT', `/academic-years/${yearId}/attendance-policies`, { levelId: null, maxAbsences: 4, warnAtAbsences: 3, exceedingAction: 'block_exam' });
check('upsert attendance policy', policy.status, 200);
check('warn >= max rejected (DDL CHECK mirrored)', (await call(HT, 'PUT', `/academic-years/${yearId}/attendance-policies`, { levelId: null, maxAbsences: 3, warnAtAbsences: 3 })).status, 400);

console.log('\n--- institute settings ---');
const settings = await call(HT, 'GET', '/institute-settings');
check('read settings', settings.status, 200);
check('WhatsApp access token never exposed (§7.8)', JSON.stringify(settings.body).toLowerCase().includes('token'), false);
show('sessions per term', settings.body.sessionsPerTerm);
show('reminder', `weekday ${settings.body.reminderWeekday} at ${settings.body.reminderSendTime}`);
check('teacher cannot change settings', (await call(T, 'PATCH', '/institute-settings', { sessionsPerTerm: 99 })).status, 403);

console.log('\n--- audit log ---');
const logs = await call(HT, 'GET', '/audit-logs?pageSize=5');
check('read audit log', logs.status, 200);
check('audit rows were written', logs.body.total > 0, true);
show('total entries', logs.body.total);
for (const l of logs.body.items.slice(0, 5)) show('entry', `${l.action} on ${l.entityType}#${l.entityId} by ${l.actorName}`);
check('BigInt id serialised as string', typeof logs.body.items[0].id, 'string');
const deleteLog = (await call(HT, 'GET', '/audit-logs?action=user.delete')).body;
check('soft delete recorded with before-state (R9)', deleteLog.items[0]?.before?.username !== undefined, true);
show('delete reason', JSON.stringify(deleteLog.items[0]?.after));
check('teacher cannot read the audit log', (await call(T, 'GET', '/audit-logs')).status, 403);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
