import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { normalizeArabic } from '../src/common/arabic';
import { SUBJECTS } from './subjects.catalogue';

/**
 * Seeds the institute's real subject catalogue and the PREP + levels 1–4
 * curriculum, read from the sample files and the printed منهج sheets
 * (samples/photos):
 *
 *  - the 13 subjects, each with the short Arabic name the result sheets use;
 *  - subject_aliases for every spelling those sheets carry (سيرة/سيره, أصول فقه,
 *    علوم قرآن …) so the results import resolves each carry/repeat token instead
 *    of flagging the row — the alias `normalized` is computed with the SAME
 *    normaliser the importer uses, so they always agree;
 *  - which subjects each level examines in term 1, term 2, or both.
 *
 *   npx ts-node prisma/seed-curriculum.ts
 *
 * Prerequisite: run seed-institute.ts first (levels PREP + L1–L4 and the current
 * year must exist). Idempotent: subjects upsert by code, aliases by normalized
 * text, curriculum by (year, level, subject, term). Scores default to 100/50 —
 * tune per subject in the Curriculum screen. COMP is left out until its subject
 * sheet is provided.
 */


// Per level (by code): which term(s) each subject is examined in. [1,2]=both.
// Transcribed from samples/photos/1..4.jpeg (the box glyph = not that term) and
// photos/5.jpeg for PREP, whose printed sheet groups قرآن/تجويد/تفسير under
// «محور القرآن» and لغة/مصطلح/أصول فقه under «علوم الآلات» — unbundled here into
// the same subjects the numbered levels use.
const CURRICULUM: Record<string, Record<string, number[]>> = {
  // PREP groups Qur'an study under محور القرآن and the tool-sciences under علوم
  // الآلات, matching photo 5's four term-1 boxes and five term-2 boxes.
  PREP: { AQEEDAH: [1], FIQH: [1, 2], QURAN_AXIS: [1, 2], FIKR: [1, 2], ALAT_SCI: [2], TAZKIYAH: [2] },
  L1: { QURAN: [1, 2], FIQH: [1, 2], AQEEDAH: [1, 2], TAJWEED: [1], HADITH_TERM: [1], TAFSEER: [1], ARABIC: [1], USUL_FIQH: [2], SEERAH: [2], FIKR: [2] },
  L2: { QURAN: [1, 2], FIQH: [1, 2], AQEEDAH: [1, 2], TAJWEED: [1], HADITH_TERM: [1], TAFSEER: [1], ARABIC: [1], USUL_FIQH: [2], SEERAH: [2], FIKR: [2] },
  L3: { QURAN: [1, 2], FIQH: [1, 2], AQEEDAH: [1, 2], QURAN_SCI: [2], TAKHREEJ: [1], TAFSEER: [1], ARABIC: [1], USUL_FIQH: [2], FIKR: [2] },
  L4: { QURAN: [1, 2], FIQH: [1, 2], AQEEDAH: [1, 2], TAKHREEJ: [1], TAFSEER: [1], ARABIC: [1], USUL_FIQH: [2], FIKR: [2] },
};

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });

  try {
    const actorId =
      (await prisma.users.findFirst({ where: { role: 'head_teacher' }, select: { id: true } }))?.id ?? null;

    // Target a specific Hijri year — the database can hold several, and the
    // newest may be a test year, so this is explicit rather than "latest".
    const targetHijri = Number(process.env.SEED_CURRICULUM_HIJRI_YEAR ?? 0);
    const year = targetHijri
      ? await prisma.academic_years.findUnique({ where: { hijri_year: targetHijri } })
      : await prisma.academic_years.findFirst({ orderBy: { hijri_year: 'desc' } });
    if (year == null) {
      throw new Error(
        targetHijri
          ? `No academic year ${targetHijri} exists.`
          : 'No academic year exists — run seed-institute.ts first.',
      );
    }
    console.log('Seeding curriculum into year', year.hijri_year, 'هـ (id', year.id + ')');

    const subjectIdByCode = new Map<string, number>();
    for (const s of SUBJECTS) {
      const subject = await prisma.subjects.upsert({
        where: { code: s.code },
        update: { name_ar: s.nameAr, short_name_ar: s.shortAr, is_active: true },
        create: { code: s.code, name_ar: s.nameAr, short_name_ar: s.shortAr },
      });
      subjectIdByCode.set(s.code, subject.id);

      for (const alias of s.aliases) {
        const normalized = normalizeArabic(alias);
        await prisma.subject_aliases.upsert({
          where: { normalized },
          update: { subject_id: subject.id, alias_ar: alias },
          create: { subject_id: subject.id, alias_ar: alias, normalized },
        });
      }
    }

    let curriculumRows = 0;
    for (const [levelCode, subjects] of Object.entries(CURRICULUM)) {
      const level = await prisma.levels.findUnique({ where: { code: levelCode } });
      if (level == null) {
        console.warn(`  ! level ${levelCode} not found — run seed-institute.ts; skipping it.`);
        continue;
      }
      for (const [subjectCode, terms] of Object.entries(subjects)) {
        const subjectId = subjectIdByCode.get(subjectCode);
        if (subjectId == null) continue;
        for (const termNumber of terms) {
          const exists = await prisma.curriculum.findFirst({
            where: { academic_year_id: year.id, level_id: level.id, subject_id: subjectId, term_number: termNumber },
          });
          if (!exists) {
            await prisma.curriculum.create({
              data: {
                academic_year_id: year.id,
                level_id: level.id,
                subject_id: subjectId,
                term_number: termNumber,
                is_examinable: true,
                is_mandatory: true,
                updated_by: actorId,
              },
            });
            curriculumRows++;
          }
        }
      }
    }

    console.log('Curriculum seed complete:');
    console.log('  academic year:    ', year.hijri_year, 'هـ');
    console.log('  subjects:         ', SUBJECTS.length);
    console.log('  curriculum rows created:', curriculumRows);
    await prisma.$disconnect();
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

main();
