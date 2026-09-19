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

// The institute's ladder, exactly as spec R1 names it: preparatory, four
// numbered years, then the terminal completion level (the only one that grants
// a certificate). sort_order is what every "study year" picker orders by. Flags
// left at their promotion-neutral defaults except the terminal level.
//
// There is deliberately no L5. An earlier revision of this seeder invented one;
// it appears nowhere in the spec and nowhere in the database, and seeding it
// would have created two classes for a level the institute does not teach.
const LEVELS = [
  { code: 'PREP', nameAr: 'المستوى التمهيدي', sortOrder: 1, isTerminal: false, grantsCertificate: false },
  { code: 'L1', nameAr: 'المستوى الأول', sortOrder: 2, isTerminal: false, grantsCertificate: false },
  { code: 'L2', nameAr: 'المستوى الثاني', sortOrder: 3, isTerminal: false, grantsCertificate: false },
  { code: 'L3', nameAr: 'المستوى الثالث', sortOrder: 4, isTerminal: false, grantsCertificate: false },
  { code: 'L4', nameAr: 'المستوى الرابع', sortOrder: 5, isTerminal: false, grantsCertificate: false },
  { code: 'COMP', nameAr: 'المستوى الختامي', sortOrder: 6, isTerminal: true, grantsCertificate: true },
] as const;

// The student address lookup: a governorate and its مراكز. Nothing else ever
// loaded these — the only inserts in the tree were one governorate and one markaz
// in the demo seed — so the المركز field on the student form had a single option
// and read as broken.
//
// Aswan's مراكز, the administrative list the institute's own paperwork uses. The
// import also resolves the «المركز» column against these names (§6.2), so a
// spelling here is what a roster file has to match.
const GOVERNORATE_AR = 'أسوان';
const MARKAZES_AR = [
  'أسوان',
  'دراو',
  'كوم أمبو',
  'نصر النوبة',
  'إدفو',
  'الرديسية',
  'البصيلية',
  'السباعية',
  'أبو سمبل',
  'كلابشة',
] as const;

// إخوة / أخوات — the wording the institute's own roster sheets use, and the
// sheet names the Excel import and export read and write (R3). One vocabulary
// everywhere beats three that mean the same thing.
const GENDERS = [
  { gender: 'male', suffix: 'إخوة' },
  { gender: 'female', suffix: 'أخوات' },
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

    // Idempotent on the natural keys the schema already declares:
    // `governorates.name_ar` is unique, and a markaz is unique within its
    // governorate — so a re-run adds only what is missing and never duplicates.
    const governorate = await prisma.governorates.upsert({
      where: { name_ar: GOVERNORATE_AR },
      update: {},
      create: { name_ar: GOVERNORATE_AR },
    });
    for (const nameAr of MARKAZES_AR) {
      await prisma.markazes.upsert({
        where: { governorate_id_name_ar: { governorate_id: governorate.id, name_ar: nameAr } },
        update: {},
        create: { governorate_id: governorate.id, name_ar: nameAr },
      });
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
        /* Matched on the unique key the database actually enforces — branch,
           year, level, gender — and deliberately NOT on `name`. A class renamed
           since it was seeded is still that class; including the name here found
           nothing and the create then failed on the constraint, which is what
           broke a second run of this "idempotent" seed. */
        const exists = await prisma.sections.findFirst({
          where: { branch_id: branch.id, academic_year_id: year.id, level_id: level.id, gender: g.gender },
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
    console.log('  governorate:     ', governorate.name_ar, `(${MARKAZES_AR.length} مركز)`);
    console.log('  levels:          ', LEVELS.length);
    console.log('  sections created:', sectionsCreated, `(of ${LEVELS.length * GENDERS.length})`);
    await prisma.$disconnect();
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

main();
