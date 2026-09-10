/**
 * READ-ONLY pre-flight for the "one class per level per gender" migration.
 * Run:  node prisma/tools/report-section-merge.mjs
 *
 * WHY THIS EXISTS
 * That migration repoints enrolments, timetable slots, sessions, attendance,
 * teacher assignments and campaigns onto a single surviving section per
 * (branch, year, level, gender), then deletes the losers. Attendance is
 * recorded history — once merged wrongly it cannot be reconstructed. So the
 * head teacher decides what merges, from real counts, before any SQL runs.
 *
 * It answers two questions:
 *   A. Is the seeder's `L5` level safe to retire? Spec R1 names six levels
 *      (PREP, L1-L4, COMP); prisma/seed-institute.ts seeds a seventh. Anything
 *      non-zero here means real records hang off it — stop and report.
 *   B. Which (branch, year, level, gender) groups hold more than one section,
 *      and what would be at stake in merging each?
 *
 * This script only SELECTs. It is safe to run against production.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..');

const env = Object.fromEntries(
  readFileSync(join(backendRoot, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [
        l.slice(0, i).trim(),
        l.slice(i + 1).trim().replace(/^["']|["']$/g, ''),
      ];
    }),
);

const url = env.DIRECT_URL || env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL / DATABASE_URL not found in .env');
  process.exit(1);
}

/** Everything that would have to move or die if a level were retired. */
const L5_USAGE = `
  SELECT l.id, l.code, l.name_ar,
    (SELECT count(*) FROM sections s WHERE s.level_id = l.id)                         AS sections,
    (SELECT count(*) FROM enrollments e JOIN sections s ON s.id = e.section_id
       WHERE s.level_id = l.id)                                                       AS enrollments,
    (SELECT count(*) FROM curriculum c WHERE c.level_id = l.id)                       AS curriculum,
    (SELECT count(*) FROM exams x JOIN curriculum c ON c.id = x.curriculum_id
       WHERE c.level_id = l.id)                                                       AS exams,
    (SELECT count(*) FROM carried_subjects cs WHERE cs.origin_level_id = l.id)        AS carries,
    (SELECT count(*) FROM progression_rules pr WHERE pr.level_id = l.id)              AS progression_rules,
    (SELECT count(*) FROM attendance_policies ap WHERE ap.level_id = l.id)            AS attendance_policies
  FROM levels l
  WHERE l.code = 'L5'
`;

/** Every section in a group that has more than one, with what it carries. */
const DUPLICATES = `
  SELECT s.branch_id, s.academic_year_id, s.level_id, l.name_ar AS level_name,
         s.gender, s.id, s.name, s.created_at,
    (SELECT count(*) FROM enrollments e WHERE e.section_id = s.id)                    AS enrollments,
    (SELECT count(*) FROM timetable_slots t WHERE t.section_id = s.id)                AS slots,
    (SELECT count(*) FROM sessions se WHERE se.section_id = s.id)                     AS sessions,
    (SELECT count(*) FROM attendance a JOIN sessions se ON se.id = a.session_id
       WHERE se.section_id = s.id)                                                    AS attendance,
    (SELECT count(*) FROM section_teachers st WHERE st.section_id = s.id)             AS teachers,
    (SELECT count(*) FROM message_campaigns mc WHERE mc.section_id = s.id)            AS campaigns
  FROM sections s
  JOIN levels l ON l.id = s.level_id
  WHERE (s.branch_id, s.academic_year_id, s.level_id, s.gender) IN (
    SELECT branch_id, academic_year_id, level_id, gender
    FROM sections
    GROUP BY 1, 2, 3, 4
    HAVING count(*) > 1
  )
  ORDER BY s.branch_id, s.academic_year_id, s.level_id, s.gender,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = s.id) DESC,
           s.created_at ASC
`;

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  console.log('\n=== A. Is L5 safe to retire? (spec R1 names six levels) ===\n');
  const l5 = await client.query(L5_USAGE);
  if (l5.rows.length === 0) {
    console.log('  No level with code L5 exists. Nothing to retire.');
  } else {
    for (const row of l5.rows) {
      const counted = [
        'sections',
        'enrollments',
        'curriculum',
        'exams',
        'carries',
        'progression_rules',
        'attendance_policies',
      ];
      const used = counted.filter((key) => Number(row[key]) > 0);
      console.log(`  ${row.code} (id ${row.id}) — ${row.name_ar}`);
      for (const key of counted) console.log(`    ${key.padEnd(20)} ${row[key]}`);
      console.log(
        used.length === 0
          ? '\n  SAFE: nothing references L5. It can be retired.\n'
          : `\n  STOP: L5 is in use (${used.join(', ')}). Do not retire it — report to the head teacher.\n`,
      );
    }
  }

  console.log('=== B. Groups holding more than one section ===\n');
  const dupes = await client.query(DUPLICATES);
  if (dupes.rows.length === 0) {
    console.log('  None. Every (branch, year, level, gender) already has exactly one');
    console.log('  section — the unique-key migration can run without merging anything.\n');
  } else {
    // Rows arrive ordered so the intended keeper (fullest, then oldest) is first
    // in each group. The migration picks the same way.
    let currentKey = '';
    for (const row of dupes.rows) {
      const key = `${row.branch_id}/${row.academic_year_id}/${row.level_id}/${row.gender}`;
      if (key !== currentKey) {
        currentKey = key;
        console.log(
          `\n  branch ${row.branch_id} · year ${row.academic_year_id} · ${row.level_name} · ${row.gender}`,
        );
      }
      console.log(
        `    ${row.id}  "${row.name}"  ` +
          `enrol=${row.enrollments} slots=${row.slots} sessions=${row.sessions} ` +
          `attendance=${row.attendance} teachers=${row.teachers} campaigns=${row.campaigns}`,
      );
    }
    console.log(
      '\n  The FIRST section listed in each group is the one the migration would keep',
      '\n  (most enrolments, then oldest). Everything else is repointed onto it.',
      '\n  Review the attendance counts before applying — that is recorded history.\n',
    );
  }
} finally {
  await client.end();
}
