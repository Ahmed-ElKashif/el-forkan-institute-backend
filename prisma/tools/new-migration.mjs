/**
 * Scaffolds the next migration:  npm run db:migrate:new -- <name>
 *
 * Diffs the live database against prisma/schema.prisma and writes the result to
 * prisma/migrations/<timestamp>_<name>/migration.sql for you to review.
 *
 * WHY THIS EXISTS RATHER THAN `prisma migrate dev`
 * `migrate dev` needs a shadow database it can create and drop, which the
 * Supabase pooler will not grant. Diffing against the live database needs no
 * shadow database.
 *
 * THE TRAP IT DEFUSES
 * Two partial UNIQUE indexes exist in the database that `schema.prisma` cannot
 * express (Prisma has no syntax for a partial unique index). Prisma therefore
 * sees them as drift and every diff begins with:
 *     DROP INDEX "certificates_one_active_per_student_level";
 *     DROP INDEX "section_teachers_one_primary_per_section";
 * Applying that would destroy the guarantee that a student holds one live
 * certificate per level, and a section has one primary teacher. This script
 * strips those statements and says so. Never re-add them by hand.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Indexes that live only in the database, by design. See prisma/tools/manual-objects.sql.
const PROTECTED_INDEXES = [
  'certificates_one_active_per_student_level',
  'section_teachers_one_primary_per_section',
];

const name = process.argv.slice(2).join('-').trim();
if (!name) {
  console.error('Usage: npm run db:migrate:new -- <migration-name>');
  process.exit(1);
}
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Prisma's JS entrypoint directly, not node_modules/.bin/prisma — Node on
// Windows refuses to spawnSync a .cmd shim (EINVAL).
const prismaEntry = join('node_modules', 'prisma', 'build', 'index.js');

const raw = execFileSync(
  process.execPath,
  [
    prismaEntry,
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
);

// Drop the CLI's env banner and any statement touching a protected index,
// together with the "-- DropIndex" comment that precedes it.
const lines = raw.split(/\r?\n/).filter((l) => !l.startsWith('◇'));
const kept = [];
let stripped = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (PROTECTED_INDEXES.some((idx) => line.includes(idx))) {
    stripped += 1;
    if (kept[kept.length - 1]?.trim() === '-- DropIndex') kept.pop();
    continue;
  }
  kept.push(line);
}

const body = kept.join('\n').trim();

if (stripped > 0) {
  console.log(
    `Stripped ${stripped} DROP INDEX statement(s) for the partial unique indexes Prisma cannot see — this is expected on every diff.`,
  );
}

if (!body) {
  console.log('\nNo schema changes to migrate. Nothing written.');
  process.exit(0);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14);
const dir = join('prisma', 'migrations', `${stamp}_${slug}`);
if (existsSync(dir)) {
  console.error(`${dir} already exists`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const file = join(dir, 'migration.sql');
writeFileSync(file, `${body}\n`);

console.log(`\nWrote ${file}`);
console.log('\nNext:');
console.log('  1. REVIEW the SQL — a rename reads as DROP + ADD and would lose data.');
console.log('  2. Apply it with:  npm run db:migrate');
