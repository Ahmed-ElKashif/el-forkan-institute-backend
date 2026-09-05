import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

/**
 * Seeds (or repairs) a head-teacher account for testing.
 *
 * Since F12, email is the login identity and a code is emailed on every login,
 * so the seed sets an email and a known password. Override either via env:
 *   SEED_HT_EMAIL=you@example.com SEED_HT_PASSWORD='YourStrongPass1!' \
 *     npx ts-node prisma/seed-head-teacher.ts
 *
 * The OTP: with RESEND_API_KEY + OTP_EMAIL_FROM set it is emailed to SEED_HT_EMAIL;
 * without them, in non-production the server logs the code to its console
 * (ResendEmailSender dev fallback), so you can still complete a login locally.
 */
async function main() {
  const email = (process.env.SEED_HT_EMAIL ?? 'head.teacher@forkan.test')
    .trim()
    .toLowerCase();
  const password = process.env.SEED_HT_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, 12);

  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });

  // Upsert repairs an account seeded before F12 (no email) as well as creating a
  // fresh one — the update branch sets email + password_hash so a re-run fixes
  // an existing row rather than leaving it un-loggable.
  const user = await prisma.users.upsert({
    where: { username: 'headteacher' },
    update: { email, password_hash: passwordHash, is_active: true },
    create: {
      full_name: 'Head Teacher (placeholder)',
      username: 'headteacher',
      gender: 'male',
      phone: '+201000000000',
      email,
      password_hash: passwordHash,
      role: 'head_teacher',
      branch_id: 1,
    },
  });

  console.log('Seeded head teacher — log in with:');
  console.log('  email:   ', email);
  console.log('  password:', password);
  console.log('  id:      ', user.id);
  await prisma.$disconnect();
}

main();
