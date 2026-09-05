import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * One-off cleanup: keep academic year 1447 (the institute's real operating year,
 * matching the sample files), delete every other year and all data hanging off
 * it, and soft-delete the students that are left with no enrollment afterwards.
 *
 *   npx ts-node prisma/cleanup-test-years.ts
 *
 * Runs as one transaction, deleting children before parents (the schema mixes
 * cascade and no-action FKs, so the order is explicit). Student ROWS in 1447 are
 * never touched; orphaned students are soft-deleted (deleted_at), not removed.
 */
const KEEP_HIJRI_YEAR = 1447;

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });

  try {
    const keep = await prisma.academic_years.findUnique({ where: { hijri_year: KEEP_HIJRI_YEAR } });
    if (keep == null) throw new Error(`Year ${KEEP_HIJRI_YEAR} not found — aborting.`);

    const victims = await prisma.academic_years.findMany({ where: { hijri_year: { not: KEEP_HIJRI_YEAR } }, select: { id: true } });
    const ids = victims.map((y) => y.id);
    if (ids.length === 0) {
      console.log('Nothing to delete — 1447 is already the only year.');
      return;
    }

    const idsOf = async (rows: Promise<Array<{ id: string | number | bigint }>>) => (await rows).map((r) => r.id);
    const secIds = (await idsOf(prisma.sections.findMany({ where: { academic_year_id: { in: ids } }, select: { id: true } }))) as string[];
    const enrIds = (await idsOf(prisma.enrollments.findMany({ where: { academic_year_id: { in: ids } }, select: { id: true } }))) as string[];
    const termIds = (await idsOf(prisma.terms.findMany({ where: { academic_year_id: { in: ids } }, select: { id: true } }))) as number[];
    const examIds = (await idsOf(prisma.exams.findMany({ where: { academic_year_id: { in: ids } }, select: { id: true } }))) as string[];
    const curriculumIds = (await idsOf(prisma.curriculum.findMany({ where: { academic_year_id: { in: ids } }, select: { id: true } }))) as number[];
    const sessionIds = (await idsOf(prisma.sessions.findMany({ where: { section_id: { in: secIds } }, select: { id: true } }))) as string[];
    const campaignIds = (await idsOf(prisma.message_campaigns.findMany({ where: { section_id: { in: secIds } }, select: { id: true } }))) as string[];
    const importJobIds = (await idsOf(prisma.import_jobs.findMany({ where: { academic_year_id: { in: ids } }, select: { id: true } }))) as string[];
    const examResultIds = (await idsOf(prisma.exam_results.findMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { exam_id: { in: examIds } }] }, select: { id: true } }))) as string[];

    // Students whose only enrollment(s) were in the victim years — captured now,
    // before those enrollments are deleted.
    const victimStudents = new Set((await prisma.enrollments.findMany({ where: { academic_year_id: { in: ids } }, select: { student_id: true } })).map((e) => e.student_id));
    const keptStudents = new Set((await prisma.enrollments.findMany({ where: { academic_year_id: keep.id }, select: { student_id: true } })).map((e) => e.student_id));
    const orphanIds = [...victimStudents].filter((sid) => !keptStudents.has(sid));

    const log: Record<string, number> = {};
    const del = async (label: string, count: Promise<{ count: number }>) => {
      log[label] = (await count).count;
    };

    await prisma.$transaction(
      async (tx) => {
        await del('grade_changes', tx.grade_changes.deleteMany({ where: { exam_result_id: { in: examResultIds } } }));
        await del('exam_results', tx.exam_results.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { exam_id: { in: examIds } }] } }));
        await del('exam_eligibility', tx.exam_eligibility.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { exam_id: { in: examIds } }] } }));
        await del('attendance', tx.attendance.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { session_id: { in: sessionIds } }] } }));
        await del('attendance_warnings', tx.attendance_warnings.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { term_id: { in: termIds } }] } }));
        await del('term_results', tx.term_results.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { term_id: { in: termIds } }] } }));
        await del('carried_subjects', tx.carried_subjects.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { from_enrollment_id: { in: enrIds } }] } }));
        await del('certificates', tx.certificates.deleteMany({ where: { OR: [{ enrollment_id: { in: enrIds } }, { academic_year_id: { in: ids } }] } }));
        await del('exams', tx.exams.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('curriculum_units', tx.curriculum_units.deleteMany({ where: { curriculum_id: { in: curriculumIds } } }));
        await del('messages', tx.messages.deleteMany({ where: { campaign_id: { in: campaignIds } } }));
        await del('message_campaigns', tx.message_campaigns.deleteMany({ where: { section_id: { in: secIds } } }));
        await del('section_teachers', tx.section_teachers.deleteMany({ where: { section_id: { in: secIds } } }));
        await del('timetable_slots', tx.timetable_slots.deleteMany({ where: { section_id: { in: secIds } } }));
        await del('sessions', tx.sessions.deleteMany({ where: { section_id: { in: secIds } } }));
        await del('import_rows', tx.import_rows.deleteMany({ where: { import_job_id: { in: importJobIds } } }));
        await del('import_jobs', tx.import_jobs.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('enrollments', tx.enrollments.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('sections', tx.sections.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('curriculum', tx.curriculum.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('attendance_policies', tx.attendance_policies.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('progression_rules', tx.progression_rules.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('terms', tx.terms.deleteMany({ where: { academic_year_id: { in: ids } } }));
        await del('academic_years', tx.academic_years.deleteMany({ where: { id: { in: ids } } }));
        await del('students(soft-deleted)', tx.students.updateMany({ where: { id: { in: orphanIds }, deleted_at: null }, data: { deleted_at: new Date() } }));
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    console.log(`Cleanup complete. Kept year ${KEEP_HIJRI_YEAR} (id ${keep.id}).`);
    for (const [table, count] of Object.entries(log)) console.log(`  ${table}: ${count}`);
    await prisma.$disconnect();
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

main();
