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
  fullName: `مرسل ${stamp}`, username: `m${stamp}`, gender: 'male',
  phone: `0102${stamp}1`, password: 'TeacherPass123', role: 'teacher', branchId: 1,
})).body;
const T = await login(`m${stamp}`, 'TeacherPass123');

const allYears = (await call(HT, 'GET', '/academic-years?pageSize=100')).body.items;
const year = (await call(HT, 'POST', '/academic-years', { hijriYear: Math.max(...allYears.map((y) => y.hijriYear)) + 1 })).body;
const term1 = year.terms.find((t) => t.termNumber === 1);
const L1 = (await call(HT, 'GET', '/levels')).body.find((l) => l.code === 'L1');
const nahwId = (await call(HT, 'GET', '/subjects?pageSize=100')).body.items.find((s) => s.code === 'NAHW').id;
const branchId = 1;

const section = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'male', name: `L1-رسائل-${stamp}`,
})).body;
await call(HT, 'POST', `/sections/${section.id}/teachers`, { userId: teacher.id, isPrimary: true });

console.log('\n--- templates (§7.8) ---');
const templates = await call(HT, 'GET', '/message-templates');
check('templates seeded', templates.status, 200);
show('codes', templates.body.map((t) => t.code).join(', '));
const friday = templates.body.find((t) => t.code === 'friday_schedule');
check('the Friday template exists (R10)', friday !== undefined, true);
check('absence warning template exists (§4.8)', templates.body.some((t) => t.code === 'absence_warning'), true);
check('teacher cannot edit a template (§3)', (await call(T, 'PATCH', `/message-templates/${friday.id}`, { body: 'hijack' })).status, 403);
const updated = await call(HT, 'PATCH', `/message-templates/${friday.id}`, { providerTemplateName: 'furqan_friday_v1' });
check('head teacher sets the Meta-approved template name', updated.status, 200);
check('...and it is stored', updated.body.providerTemplateName, 'furqan_friday_v1');

console.log('\n--- phone coverage gate (§6.4) ---');
// Three students, only one with a number → 33% coverage.
const students = [];
for (let i = 0; i < 3; i += 1) {
  const s = (await call(HT, 'POST', '/students', {
    fullName: `مستلم ${i} ${stamp}`, gender: 'male', branchId,
    ...(i === 0 ? { phone: `0103${stamp}${i}` } : {}),
  })).body;
  await call(HT, 'POST', '/enrollments', { studentId: s.id, sectionId: section.id });
  students.push(s);
}
const coverage = await call(HT, 'GET', `/sections/${section.id}/phone-coverage`);
show('coverage', `${coverage.body.withPhone}/${coverage.body.total} = ${coverage.body.percentage}%`);

// A Friday with a real session on it.
await call(HT, 'POST', `/sections/${section.id}/timetable`, {
  subjectId: nahwId, teacherId: teacher.id, weekday: 5, slotOrder: 1, startsAt: '09:00', endsAt: '10:30',
});
await call(HT, 'POST', `/sections/${section.id}/sessions/generate`, { termId: term1.id });
const targetDate = term1.startsOn;

const blocked = await call(HT, 'POST', '/campaigns/friday-reminder', { sectionId: section.id, targetDate });
check('a section with thin phone coverage is REFUSED (§6.4)', blocked.status, 409);
show('message', blocked.body?.message);

// Fill the remaining numbers.
for (let i = 1; i < 3; i += 1) {
  await call(HT, 'PATCH', `/students/${students[i].id}`, { phone: `0104${stamp}${i}` });
}
check('coverage is now 100%', (await call(HT, 'GET', `/sections/${section.id}/phone-coverage`)).body.percentage, 100);

console.log('\n--- queueing the Friday reminder (R10) ---');
const campaign = await call(HT, 'POST', '/campaigns/friday-reminder', { sectionId: section.id, targetDate });
check('campaign queued', campaign.status, 201);
show('campaign', `${campaign.body.templateCode} for ${campaign.body.sectionName} on ${campaign.body.targetDate}`);
check('one message per student (R10: every student)', campaign.body.counts.queued, 3);
check('nothing sent yet — queue and send are separate steps', campaign.body.counts.sent, 0);

// §7.7: message_campaigns is UNIQUE (template, section, target_date). This is
// the guard that replaces a queue.
const duplicate = await call(HT, 'POST', '/campaigns/friday-reminder', { sectionId: section.id, targetDate });
check('a second campaign for the same section+date is REFUSED (§7.7 idempotency)', duplicate.status, 409);
show('message', duplicate.body?.message);

console.log('\n--- sending (§7.8 lead time) ---');
const send = await call(HT, 'POST', `/campaigns/${campaign.body.id}/send`);
check('send refuses while WhatsApp is unconfigured, rather than failing the rows', send.status, 409);
show('message', send.body?.message);
const stillQueued = await call(HT, 'GET', `/campaigns/${campaign.body.id}`);
check('the messages stay QUEUED, not failed — nothing to un-fail once approval lands', stillQueued.body.counts.queued, 3);
check('...and none were marked failed', stillQueued.body.counts.failed, 0);

console.log('\n--- rendered bodies are stored as evidence (§5.1) ---');
const audit = await call(HT, 'GET', '/audit-logs?action=campaign.queue&pageSize=1');
check('queueing is audited', audit.body.total > 0, true);
show('audit', JSON.stringify(audit.body.items[0].after));

console.log('\n--- scoping (§3: own section only) ---');
const otherSection = (await call(HT, 'POST', '/sections', {
  branchId, academicYearId: year.id, levelId: L1.id, gender: 'female', name: `L1-اخرى-${stamp}`,
})).body;
check('teacher cannot queue for a section that is not theirs',
  (await call(T, 'POST', '/campaigns/friday-reminder', { sectionId: otherSection.id, targetDate })).status, 404);
const teacherCampaigns = await call(T, 'GET', '/campaigns');
check('teacher sees only their own campaigns', teacherCampaigns.body.every((c) => c.sectionId === section.id), true);
show('teacher sees', `${teacherCampaigns.body.length} campaign(s)`);
const headCampaigns = await call(HT, 'GET', '/campaigns');
check('head teacher sees more', headCampaigns.body.length >= teacherCampaigns.body.length, true);

console.log('\n--- rate limiting the send path (§9) ---');
let limited = 0;
for (let i = 0; i < 8; i += 1) {
  const r = await call(HT, 'POST', `/campaigns/${campaign.body.id}/send`);
  if (r.status === 429) limited += 1;
}
check('the send path is rate limited — "a loop bug messages real people"', limited > 0, true);
show('429s', `${limited} of 8`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
