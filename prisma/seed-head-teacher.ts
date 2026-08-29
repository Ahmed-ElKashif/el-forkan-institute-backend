import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });

  const passwordHash = await bcrypt.hash('ChangeMe123!', 12);

  const user = await prisma.users.upsert({
    where: { username: 'headteacher' },
    update: {},
    create: {
      full_name: 'Head Teacher (placeholder)',
      username: 'headteacher',
      gender: 'male',
      phone: '+201000000000',
      password_hash: passwordHash,
      role: 'head_teacher',
      branch_id: 1,
    },
  });

  console.log('Seeded user:', user.username, user.id);
  await prisma.$disconnect();
}

main();
