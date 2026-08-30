// Applies prisma/tools/manual-objects.sql — the Prisma-invisible DB objects
// (partial unique indexes) that `prisma db push` drops and cannot recreate.
// Uses `pg` directly because Prisma 7's CLI no longer ships `db execute`.
// Idempotent: the SQL uses CREATE ... IF NOT EXISTS, so re-running is safe.
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

const sql = readFileSync(join(here, 'manual-objects.sql'), 'utf8');
const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(sql);
  console.log('Applied prisma/tools/manual-objects.sql');
} finally {
  await client.end();
}
