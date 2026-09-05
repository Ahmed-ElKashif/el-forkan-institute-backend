import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * One-time institute bootstrap so the legacy Excel roster files can be imported.
 *
 * Creates the operating structure the import needs — the current academic year
 * with its two terms (semesters), the seven academic levels, and one boys + one
 * girls class per level (14 sections). After this runs, importing a
 * "<level> name's list" file is: Import screen -> pick that level's section ->
 * upload; every student in the file is enrolled into that level.
 *
 *   npx ts-node prisma/seed-institute.ts
 *
 * Idempotent: every row is matched by its natural key and only created when
 * missing, so re-running is safe. Override the year/branch if needed:
 *   SEED_HIJRI_YEAR=1448 SEED_BRANCH_NAME='الفرع الرئيسي' \
 *     npx ts-node prisma/seed-institute.ts
 *
 * Scope note: the "<level> grades" files additionally need the examinable
 * subjects/curriculum for each level+term configured (via the Catalogue screen).
 * This seed covers the roster prerequisite only.
 */

// The institute's ladder: preparatory, five numbered years, then the terminal
// completion level (the only one that grants a certificate). sort_order is what
// every "study year" picker orders by. Flags left at their promotion-neutral
// defaults except the terminal level — tune per the institute's rules later.
const LEVELS = [
  { code: 'PREP', nameAr: 'المستوى التمهيدي', sortOrder: 1, isTerminal: false, grantsCertificate: false },
  { code: 'L1', nameAr: 'المستوى الأول', sortOrder: 2, isTerminal: false, grantsCertificate: false },
  { code: 'L2', nameAr: 'المستوى الثاني', sortOrder: 3, isTerminal: false, grantsCertificate: false },
  { code: 'L3', nameAr: 'المستوى الثالث', sortOrder: 4, isTerminal: false, grantsCertificate: false },
  { code: 'L4', nameAr: 'المستوى الرابع', sortOrder: 5, isTerminal: false, grantsCertificate: false },
  { code: 'L5', nameAr: 'المستوى الخامس', sortOrder: 6, isTerminal: false, grantsCertificate: false },
  { code: 'COMP', nameAr: 'المستوى الختامي', sortOrder: 7, isTerminal: true, grantsCertificate: true },
] as const;

const GENDERS = [
  { gender: 'male', suffix: 'بنون' },
  { gender: 'female', suffix: 'بنات' },
] as const;

function dateOnly(base: Date, addDays: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + addDays);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });

  try {
    const branch =
      (await prisma.branches.findFirst({ orderBy: { id: 'asc' } })) ??
      (await prisma.branches.create({
        data: { name_ar: process.env.SEED_BRANCH_NAME ?? 'الفرع الرئيسي' },
      }));

    // Reuse the newest existing year (the institute's operating year); create one
    // only on an empty database.
    const year =
      (await prisma.academic_years.findFirst({ orderBy: { hijri_year: 'desc' } })) ??
      (await prisma.academic_years.create({
        data: {
          hijri_year: Number(process.env.SEED_HIJRI_YEAR ?? 1448),
          starts_on: dateOnly(new Date(), -30),
          ends_on: dateOnly(new Date(), 300),
          status: 'active',
        },
      }));

    for (const termNumber of [1, 2]) {
      const exists = await prisma.terms.findFirst({
        where: { academic_year_id: year.id, term_number: termNumber },
      });
      if (!exists) {
        await prisma.terms.create({
          data: {
            academic_year_id: year.id,
            term_number: termNumber,
            starts_on: dateOnly(year.starts_on, termNumber === 1 ? 0 : 150),
            ends_on: dateOnly(year.starts_on, termNumber === 1 ? 149 : 300),
            status: termNumber === 1 ? 'active' : 'planned',
          },
        });
      }
    }

    let sectionsCreated = 0;
    for (const l of LEVELS) {
      const level = await prisma.levels.upsert({
        where: { code: l.code },
        update: { name_ar: l.nameAr, sort_order: l.sortOrder, is_terminal: l.isTerminal, grants_certificate: l.grantsCertificate },
        create: { code: l.code, name_ar: l.nameAr, sort_order: l.sortOrder, is_terminal: l.isTerminal, grants_certificate: l.grantsCertificate },
      });

      for (const g of GENDERS) {
        const name = `${l.nameAr} — ${g.suffix}`;
        const exists = await prisma.sections.findFirst({
          where: { branch_id: branch.id, academic_year_id: year.id, level_id: level.id, gender: g.gender, name },
        });
        if (!exists) {
          await prisma.sections.create({
            data: { branch_id: branch.id, academic_year_id: year.id, level_id: level.id, gender: g.gender, name },
          });
          sectionsCreated++;
        }
      }
    }

    console.log('Institute bootstrap complete:');
    console.log('  branch:          ', branch.name_ar);
    console.log('  academic year:   ', year.hijri_year, 'هـ');
    console.log('  levels:          ', LEVELS.length);
    console.log('  sections created:', sectionsCreated, `(of ${LEVELS.length * GENDERS.length})`);
    await prisma.$disconnect();
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

main();
