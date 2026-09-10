/**
 * DESTRUCTIVE. Clears smoke-test class debris so one-class-per-level can apply.
 * Run:  node prisma/tools/purge-smoke-sections.mjs --confirm
 *
 * WHY THIS EXISTS
 * The b3-b6 smoke suites each created a fresh L1 section per run and never
 * cleaned up, leaving 29 classes piled on one level while every other level had
 * none. The one-class-per-level unique index cannot apply over that, and
 * merging the rows would have promoted a generated name like
 * `L1-تدريس-520635` into a permanent class name.
 *
 * WHAT IT DELETES
 * Every section, and everything that hangs off one, in foreign-key order.
 * Students are deliberately LEFT ALONE: they are a separate record that the
 * import owns, and a student with no enrolment is a valid state.
 *
 * One transaction — it either clears completely or changes nothing.
 * Verify first with:  node prisma/tools/report-section-merge.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

if (!process.argv.includes('--confirm')) {
  console.error(
    'Refusing to run without --confirm. This deletes every section and all\n' +
      'enrolments, sessions, attendance and results that hang off them.\n' +
      'Run the report first:  node prisma/tools/report-section-merge.mjs',
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

/* Foreign-key order: the deepest dependant first. `enrollments.section_id` is
   RESTRICT, so everything pointing at an enrolment has to go before it, and
   everything pointing at a section before that. */
const STEPS = [
  ['grade_changes', 'DELETE FROM grade_changes'],
  ['attendance', 'DELETE FROM attendance'],
  ['attendance_warnings', 'DELETE FROM attendance_warnings'],
  ['carried_subjects', 'DELETE FROM carried_subjects'],
  ['certificates', 'DELETE FROM certificates'],
  ['exam_results', 'DELETE FROM exam_results'],
  ['exam_eligibility', 'DELETE FROM exam_eligibility'],
  ['term_results', 'DELETE FROM term_results'],
  ['messages', 'DELETE FROM messages'],
  ['message_campaigns', 'DELETE FROM message_campaigns'],
  ['sessions', 'DELETE FROM sessions'],
  ['timetable_slots', 'DELETE FROM timetable_slots'],
  ['section_teachers', 'DELETE FROM section_teachers'],
  ['enrollments', 'DELETE FROM enrollments'],
  ['sections', 'DELETE FROM sections'],
];

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('BEGIN');
  for (const [label, sql] of STEPS) {
    const { rowCount } = await client.query(sql);
    console.log(`  ${String(rowCount).padStart(5)}  ${label}`);
  }
  await client.query('COMMIT');
  console.log('\nCleared. Next:');
  console.log('  1. npm run db:migrate           # apply one-class-per-level');
  console.log('  2. POST /sections/provision     # create the twelve classes');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('\nRolled back — nothing was deleted.');
  throw error;
} finally {
  await client.end();
}
