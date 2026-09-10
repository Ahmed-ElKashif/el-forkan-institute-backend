/**
 * DESTRUCTIVE. Clears the smoke-test debris and seeds a coherent demo institute.
 * Run:  node prisma/tools/seed-demo.mjs --confirm
 *
 * WHAT IT KEEPS
 * The institute's real configuration — levels, subjects, curriculum, academic
 * year 1447 and its terms, the branch, governorate and markaz — and the head
 * teacher account, which is the login. Everything else transactional is rebuilt.
 *
 * WHAT IT BUILDS
 * Three levels taught to both genders (R1 x R3 = one class per level per
 * gender, so six classes), each with a teacher, a roster, a weekly timetable,
 * six weeks of sessions with realistic attendance, term-1 exams with marks, and
 * a prior year (1446) so that carried subjects are real rather than invented:
 * an L3 student carrying a subject failed at L2 has a genuine
 * `from_enrollment_id` to point at, which the CHECK constraint requires.
 *
 * One transaction — it either builds completely or changes nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

/* --dry-run executes the whole seed and then rolls it back, so the SQL is
   proved against the real database without changing anything. Use it to find a
   failure before committing to one. */
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && !process.argv.includes('--confirm')) {
  console.error(
    'Refusing to run without --confirm. This deletes every student, teacher\n' +
      'account and transactional row, then seeds demo data in their place.',
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '..', '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const client = new pg.Client({
  connectionString: env.DIRECT_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* Aswan names, so a demo reads like the institute's own roster rather than
   `طالب اختبار 139389`. Eight per class: enough to fill a screen, few enough to
   read at a glance. */
const BOYS = [
  'أحمد محمود عبد الرحمن', 'محمد سيد أبو الحسن', 'عبد الله ياسر النوبي',
  'مصطفى كامل إدريس', 'عمر حسن الشاذلي', 'يوسف طارق بدر',
  'خالد إبراهيم العيسوي', 'إبراهيم عاطف قناوي',
];
const GIRLS = [
  'فاطمة الزهراء أحمد', 'عائشة محمد الأمين', 'مريم صلاح الدين',
  'خديجة عبد الفتاح', 'زينب مصطفى النجار', 'أسماء عادل حسين',
  'رقية سامي الطيب', 'سمية ناصر عبد العال',
];
const MALE_TEACHERS = ['الشيخ عبد الرحمن الأسواني', 'الشيخ محمود قناوي', 'الشيخ ياسر النوبي'];
const FEMALE_TEACHERS = ['الأستاذة نور الهدى إدريس', 'الأستاذة سارة محمد الأسوانية', 'الأستاذة هدى عبد اللطيف'];

const LEVELS = [
  { id: 2, code: 'L1', nameAr: 'المستوى الأول' },
  { id: 3, code: 'L2', nameAr: 'المستوى الثانى' },
  { id: 4, code: 'L3', nameAr: 'المستوى الثالث' },
];
const GENDERS = [
  { gender: 'male', suffix: 'إخوة', names: BOYS, teachers: MALE_TEACHERS },
  { gender: 'female', suffix: 'أخوات', names: GIRLS, teachers: FEMALE_TEACHERS },
];

/* Six Fridays inside term 1 (R4: Friday is the default lecture day). All in the
   past, so attendance on them is a record rather than a prediction. */
const SESSION_DATES = ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31', '2026-08-07'];

const q = (text, values) => client.query(text, values);
const one = async (text, values) => (await q(text, values)).rows[0];
const all = async (text, values) => (await q(text, values)).rows;

await client.connect();
try {
  await q('BEGIN');

  // ---------------------------------------------------------------- purge
  // FK order, deepest first. `enrollments.section_id` is RESTRICT, so
  // everything pointing at an enrolment goes before it.
  const purge = [
    'grade_changes', 'attendance', 'attendance_warnings', 'carried_subjects',
    'certificates', 'promotion_overrides', 'exam_results', 'exam_eligibility',
    'term_results', 'exams', 'messages', 'message_campaigns', 'sessions',
    'timetable_slots', 'section_teachers', 'enrollments', 'sections',
    'placement_assessments', 'import_rows', 'import_jobs', 'students',
    /* Last, and load-bearing: `audit_logs.actor_id` references `users` with NO
       ACTION, so 38 rows logged by smoke-test teachers would block the teacher
       delete below and roll the whole seed back. The log is smoke-test history
       either way — the demo starts its own. */
    'audit_logs',
  ];
  for (const table of purge) {
    const { rowCount } = await q(`DELETE FROM ${table}`);
    if (rowCount > 0) console.log(`  purged ${String(rowCount).padStart(4)}  ${table}`);
  }
  // Teacher accounts only — the head teacher is the login and must survive.
  const dropped = await q("DELETE FROM users WHERE role = 'teacher'");
  console.log(`  purged ${String(dropped.rowCount).padStart(4)}  users (teachers)`);

  // A demo should not open on "Head Teacher (placeholder)".
  await q(
    "UPDATE users SET full_name = 'الشيخ محمود عبد الله الأسواني' WHERE role = 'head_teacher' AND full_name LIKE '%placeholder%'",
  );

  const branchId = (await one('SELECT id FROM branches ORDER BY id LIMIT 1')).id;
  const markazId = (await one('SELECT id FROM markazes ORDER BY id LIMIT 1')).id;
  const govId = (await one('SELECT id FROM governorates ORDER BY id LIMIT 1')).id;
  const yearId = (await one('SELECT id FROM academic_years WHERE hijri_year = 1447')).id;
  const term1 = (await one('SELECT id FROM terms WHERE academic_year_id = $1 AND term_number = 1', [yearId])).id;
  const headTeacherId = (await one("SELECT id FROM users WHERE role = 'head_teacher' ORDER BY created_at LIMIT 1")).id;
  const fridayTemplateId = (await one("SELECT id FROM message_templates WHERE code = 'friday_schedule'")).id;

  // The prior year exists so a carried subject has a real enrolment to have been
  // failed in — §4.6 reads the origin year off `from_enrollment_id`.
  const priorYearId = (
    await one(
      `INSERT INTO academic_years (hijri_year, starts_on, ends_on, status)
       VALUES (1446, DATE '2025-04-14', DATE '2026-02-02', 'closed')
       ON CONFLICT (hijri_year) DO UPDATE SET status = 'closed'
       RETURNING id`,
    )
  ).id;

  // ------------------------------------------------------------- teachers
  const teacherIds = {};
  for (const { gender, teachers } of GENDERS) {
    teacherIds[gender] = [];
    for (const [i, fullName] of teachers.entries()) {
      const row = await one(
        `INSERT INTO users (full_name, username, email, phone, gender, role, branch_id, is_active, password_hash)
         VALUES ($1,$2,$3,$4,$5,'teacher',$6,true,$7) RETURNING id`,
        [
          fullName,
          `${gender === 'male' ? 'ust' : 'usta'}${i + 1}`,
          `${gender === 'male' ? 'ust' : 'usta'}${i + 1}@elforkan.example`,
          `+2010${gender === 'male' ? '1' : '2'}${String(1000000 + i).slice(-7)}`,
          gender,
          branchId,
          // bcrypt of "ChangeMe123!" — the same placeholder the seeder uses.
          '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewYFHRJvBGvJOOWy',
        ],
      );
      teacherIds[gender].push(row.id);
    }
  }
  console.log('  teachers: 6');

  // ------------------------------------------------- classes and rosters
  let studentSeq = 0;
  let sectionCount = 0;
  let enrollmentCount = 0;
  const created = [];

  for (const [levelIndex, level] of LEVELS.entries()) {
    for (const { gender, suffix, names, teachers } of GENDERS) {
      const section = await one(
        `INSERT INTO sections (branch_id, academic_year_id, level_id, gender, name, capacity)
         VALUES ($1,$2,$3,$4,$5,25) RETURNING id`,
        [branchId, yearId, level.id, gender, `${level.nameAr} — ${suffix}`],
      );
      sectionCount += 1;

      const teacherId = teacherIds[gender][levelIndex % teachers.length];
      await q(
        `INSERT INTO section_teachers (section_id, user_id, gender, is_primary)
         VALUES ($1,$2,$3,true)`,
        [section.id, teacherId, gender],
      );

      const enrollments = [];
      for (const fullName of names) {
        studentSeq += 1;
        const code = `1447-${String(studentSeq).padStart(4, '0')}`;
        const student = await one(
          `INSERT INTO students (student_code, full_name, gender, branch_id, phone, whatsapp_phone,
                                 governorate_id, markaz_id, address, birth_date, status, whatsapp_opt_in)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'أسوان — إدفو', DATE '2008-05-01','active',true)
           RETURNING id`,
          [code, fullName, gender, branchId, `+2011${String(2000000 + studentSeq).slice(-7)}`, govId, markazId],
        );
        const enrollment = await one(
          `INSERT INTO enrollments (student_id, section_id, academic_year_id, branch_id, gender, entry_type, status)
           VALUES ($1,$2,$3,$4,$5,'new','active') RETURNING id`,
          [student.id, section.id, yearId, branchId, gender],
        );
        enrollments.push({ id: enrollment.id, studentId: student.id, fullName });
        enrollmentCount += 1;
      }

      created.push({ level, gender, section: section.id, teacherId, enrollments });
    }
  }
  console.log(`  classes: ${sectionCount}   students: ${studentSeq}   enrolments: ${enrollmentCount}`);

  // ------------------------------------------- timetable, sessions, marks
  let slots = 0, sessions = 0, marks = 0, results = 0, carries = 0;
  let termResults = 0, certificates = 0, placements = 0, overrides = 0;

  for (const entry of created) {
    const curriculum = await all(
      `SELECT c.id, c.subject_id, c.is_mandatory, c.pass_score, c.max_score
       FROM curriculum c
       WHERE c.level_id = $1 AND c.term_number = 1 AND c.is_examinable
       ORDER BY c.id LIMIT 4`,
      [entry.level.id],
    );

    // Weekly timetable: Friday (weekday 5), one slot per subject, back to back.
    for (const [i, row] of curriculum.entries()) {
      await q(
        `INSERT INTO timetable_slots (section_id, subject_id, weekday, slot_order, starts_at, ends_at, teacher_id, mode)
         VALUES ($1,$2,5,$3,$4,$5,$6,'onsite')`,
        [entry.section, row.subject_id, i + 1, `${9 + i}:00`, `${10 + i}:00`, entry.teacherId],
      );
      slots += 1;
    }

    // Six Fridays of the first subject, with attendance on each.
    const firstSubject = curriculum[0];
    for (const date of SESSION_DATES) {
      /* `sessions` names its teacher `teacher_id`, and its id defaults — an
         earlier draft wrote `user_id` and a generated id, which are columns of
         Supabase's `auth.sessions`, not this one. Two tables share the name in
         this database; always qualify the schema when checking. */
      const { id: sessionId } = await one(
        `INSERT INTO sessions (section_id, subject_id, teacher_id, session_date, starts_at, ends_at, mode, status)
         VALUES ($1,$2,$3,$4,'09:00','10:00','onsite','held') RETURNING id`,
        [entry.section, firstSubject.subject_id, entry.teacherId, date],
      );
      sessions += 1;

      for (const [i, enrollment] of entry.enrollments.entries()) {
        /* Mostly present, with a believable spread. The last student in each
           class misses enough to trip the absence policy, so the profile's
           warning banner has something real to show. */
        const isChronic = i === entry.enrollments.length - 1;
        const status = isChronic
          ? (['absent', 'absent', 'present', 'absent', 'late', 'absent'][SESSION_DATES.indexOf(date)])
          : i % 7 === 0 && date === '2026-07-17'
            ? 'excused'
            : i % 5 === 0 && date === '2026-07-31'
              ? 'late'
              : 'present';
        /* CHECK (status <> 'absent' OR attended_mode IS NULL): someone who did
           not come did not come *in a mode*. Excused is the same — the mode
           describes an attendance that actually happened. */
        const attended = status === 'present' || status === 'late';
        await q(
          `INSERT INTO attendance (session_id, enrollment_id, status, attended_mode, minutes_late, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            sessionId,
            enrollment.id,
            status,
            attended ? 'onsite' : null,
            status === 'late' ? 10 : null,
            entry.teacherId,
          ],
        );
        marks += 1;
      }
    }

    // Term-1 exams with marks, so results and promotion have something to read.
    for (const row of curriculum) {
      const exam = await one(
        `INSERT INTO exams (branch_id, academic_year_id, term_id, curriculum_id, gender, exam_type, is_locked, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,'term_1',true, TIMESTAMPTZ '2026-08-14 09:00+02')
         RETURNING id`,
        [branchId, yearId, term1, row.id, entry.gender],
      );
      for (const [i, enrollment] of entry.enrollments.entries()) {
        await q(
          `INSERT INTO exam_eligibility (exam_id, enrollment_id, is_eligible, reason_code)
           VALUES ($1,$2,true,'new')`,
          [exam.id, enrollment.id],
        );
        /* One student per class fails one non-mandatory subject: enough for the
           promotion preview to show `promote_with_carry` beside plain
           `promote`, which is the row the head teacher most wants to see. */
        const fails = i === 2 && !row.is_mandatory;
        const score = fails ? 42 : 65 + ((i * 7) % 30);
        await q(
          `INSERT INTO exam_results (exam_id, enrollment_id, score, is_absent, result, entered_by)
           VALUES ($1,$2,$3,false,$4,$5)`,
          [exam.id, enrollment.id, score, score >= Number(row.pass_score) ? 'pass' : 'fail', entry.teacherId],
        );
        results += 1;
      }
    }

    /* Term-1 results, so the term-results screen and the promotion run read off
       something computed rather than an empty table. */
    for (const enrollment of entry.enrollments) {
      const totals = await one(
        `SELECT COALESCE(SUM(r.score),0) total,
                COALESCE(SUM(c.max_score),0) max_total,
                COUNT(*) FILTER (WHERE r.result = 'fail') failed,
                COUNT(*) FILTER (WHERE r.result = 'fail' AND c.is_mandatory) mandatory_failed
         FROM exam_results r
         JOIN exams e ON e.id = r.exam_id
         JOIN curriculum c ON c.id = e.curriculum_id
         WHERE r.enrollment_id = $1`,
        [enrollment.id],
      );
      const pct = Number(totals.max_total) > 0
        ? (Number(totals.total) / Number(totals.max_total)) * 100
        : null;
      await q(
        `INSERT INTO term_results (enrollment_id, term_id, total_score, max_total, percentage,
                                   subjects_failed, mandatory_failed, result, finalized_by, finalized_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, TIMESTAMPTZ '2026-08-28 12:00+02')`,
        [
          enrollment.id, term1, totals.total, totals.max_total, pct?.toFixed(2) ?? null,
          Number(totals.failed), Number(totals.mandatory_failed),
          Number(totals.mandatory_failed) > 0 ? 'fail' : 'pass',
          headTeacherId,
        ],
      );
      termResults += 1;
    }

    /* The chronic absentee has tripped the policy, so the profile's absence
       banner and the "warn" action have a real threshold behind them. */
    const chronic = entry.enrollments[entry.enrollments.length - 1];
    await q(
      `INSERT INTO attendance_warnings (enrollment_id, term_id, threshold, absence_count)
       VALUES ($1,$2,3,4)`,
      [chronic.id, term1],
    );

    // A Friday reminder campaign per class, so the WhatsApp console has history.
    await q(
      `INSERT INTO message_campaigns (template_id, section_id, target_date, status)
       VALUES ($1,$2, DATE '2026-08-06','completed')`,
      [fridayTemplateId, entry.section],
    );

    /* Last year's history for the L3 classes: everyone sat L2, most passed
       cleanly and hold a certificate for it, and two finished
       `promote_with_carry` — which is what gives their carried subjects a real
       `from_enrollment_id` to point at (the CHECK forbids self-reference). */
    if (entry.level.code === 'L3') {
      const priorSection = await one(
        `INSERT INTO sections (branch_id, academic_year_id, level_id, gender, name, capacity)
         VALUES ($1,$2,3,$3,$4,25) RETURNING id`,
        [branchId, priorYearId, entry.gender, `المستوى الثانى — ${entry.gender === 'male' ? 'إخوة' : 'أخوات'}`],
      );
      const carried = await all(
        `SELECT c.subject_id, c.level_id FROM curriculum c
         WHERE c.level_id = 3 AND c.term_number = 1 AND c.is_examinable
         ORDER BY c.id LIMIT 2`,
      );

      for (const [i, enrollment] of entry.enrollments.entries()) {
        const withCarry = i < 2;
        const prior = await one(
          `INSERT INTO enrollments (student_id, section_id, academic_year_id, branch_id, gender,
                                    entry_type, status, final_decision, decided_at, decided_by)
           VALUES ($1,$2,$3,$4,$5,'new','completed',$6, TIMESTAMPTZ '2026-02-01 12:00+02',$7)
           RETURNING id`,
          [
            enrollment.studentId, priorSection.id, priorYearId, branchId, entry.gender,
            withCarry ? 'promote_with_carry' : 'promote', headTeacherId,
          ],
        );

        if (withCarry) {
          for (const [j, subject] of carried.entries()) {
            // One still owed, one already made good — so the profile panel and
            // the roster's «المواد المحمولة» column show both states.
            const cleared = i === 1 && j === 0;
            await q(
              `INSERT INTO carried_subjects (enrollment_id, from_enrollment_id, subject_id, origin_level_id, status, cleared_at)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [
                enrollment.id, prior.id, subject.subject_id, subject.level_id,
                cleared ? 'cleared' : 'pending',
                cleared ? new Date('2026-08-20T10:00:00Z') : null,
              ],
            );
            carries += 1;
          }
        } else {
          // R19: every level grants a certificate, issued by the head teacher.
          await q(
            `INSERT INTO certificates (student_id, level_id, enrollment_id, academic_year_id, branch_id,
                                       serial_no, issued_by, issued_at)
             VALUES ($1,3,$2,$3,$4,$5,$6, TIMESTAMPTZ '2026-02-10 10:00+02')`,
            [
              enrollment.studentId, prior.id, priorYearId, branchId,
              `L2-1446-${String(certificates + 1).padStart(4, '0')}`, headTeacherId,
            ],
          );
          certificates += 1;
        }
      }

      /* One promotion decision the head teacher disagreed with, so the override
         is visible on the run rather than only reachable by making one. */
      const overridden = entry.enrollments[3];
      await q(
        `INSERT INTO promotion_overrides (enrollment_id, after_makeup, decision, reason, overridden_by)
         VALUES ($1,false,'repeat',$2,$3)`,
        [
          overridden.id,
          'غياب متكرر غير مسجَّل في الحضور، وبقرار من مجلس المعهد يعيد المستوى.',
          headTeacherId,
        ],
      );
      overrides += 1;
    }

    /* Two students per class entered by placement rather than sequence (R2), so
       the profile's placements panel is not empty. */
    for (const enrollment of entry.enrollments.slice(0, 2)) {
      await q(
        `INSERT INTO placement_assessments (student_id, method, placed_level_id, score, max_score,
                                            pass_score, is_passed, assessed_on, created_by)
         VALUES ($1,'entrance_exam',$2,44,50,25,true, DATE '2026-03-20',$3)`,
        [enrollment.studentId, entry.level.id, headTeacherId],
      );
      placements += 1;
    }
  }

  console.log(`  timetable slots: ${slots}   sessions: ${sessions}   attendance: ${marks}`);
  console.log(`  exam results: ${results}   term results: ${termResults}`);
  console.log(`  carried subjects: ${carries}   certificates: ${certificates}`);
  console.log(`  placements: ${placements}   promotion overrides: ${overrides}`);

  if (DRY_RUN) {
    await q('ROLLBACK');
    console.log('\nDRY RUN OK — every statement succeeded, then rolled back.');
    console.log('Nothing was changed. Re-run with --confirm to keep it.');
  } else {
    await q('COMMIT');
    console.log('\nDemo institute ready.');
  }
} catch (error) {
  await q('ROLLBACK');
  /* Loudly, and in the database's own words: a silent rollback reads as "the
     script did nothing", which sends you looking in the wrong place. */
  console.error('\n=== FAILED — rolled back, nothing was changed ===');
  console.error('  ' + error.message);
  if (error.detail) console.error('  detail:     ' + error.detail);
  if (error.table) console.error('  table:      ' + error.table);
  if (error.constraint) console.error('  constraint: ' + error.constraint);
  process.exitCode = 1;
} finally {
  await client.end();
}
