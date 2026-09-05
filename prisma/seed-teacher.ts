import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

/**
 * Seeds (or repairs) a normal teacher account for testing.
 *
 * Login is by email + password, with a code emailed on every login. Override the
 * email/password via env so the OTP reaches an inbox you control:
 *   SEED_TEACHER_EMAIL=you@gmail.com SEED_TEACHER_PASSWORD='YourStrongPass1!' \
 *     npx ts-node prisma/seed-teacher.ts
 *
 * The OTP: with RESEND_API_KEY + OTP_EMAIL_FROM set it is emailed to the address;
 * without them, in non-production the server logs the code to its console
 * (ResendEmailSender dev fallback), so you can still complete a login locally.
 */
async function main() {
  const email = (process.env.SEED_TEACHER_EMAIL ?? 'teacher@forkan.test')
    .trim()
    .toLowerCase();
  const password = process.env.SEED_TEACHER_PASSWORD ?? 'Teacher123!';
  const passwordHash = await bcrypt.hash(password, 12);

  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });

  // Upsert so a re-run repairs the row (email + password) rather than failing on
  // the unique username.
  const user = await prisma.users.upsert({
    where: { username: 'teacher' },
    update: { email, password_hash: passwordHash, is_active: true },
    create: {
      full_name: 'Teacher (placeholder)',
      username: 'teacher',
      gender: 'male',
      phone: '+201000000001',
      email,
      password_hash: passwordHash,
      role: 'teacher',
      branch_id: 1,
    },
  });

  console.log('Seeded teacher — log in with:');
  console.log('  email:   ', email);
  console.log('  password:', password);
  console.log('  id:      ', user.id);
  await prisma.$disconnect();
}

main();
