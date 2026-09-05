import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Seeds a self-contained DEMO cohort so the attendance and scores pages can be
 * viewed with realistic data before launch. Nothing here touches real records:
 * it uses a dedicated demo section, demo students (`DEMO-####` codes) and demo
 * subjects (`DEMO_*` codes), and re-running wipes and rebuilds only that demo
 * data. Real catalogue/year rows are reused when present, created when absent.
 *
 *   npx ts-node prisma/seed-demo.ts
 *
 * What it builds, following the spec:
 *  - one male section (R3: gender is consistent across student → enrollment →
 *    section, which the composite FKs require), 6 enrolled students;
 *  - ~12 dated sessions inside the term (§6.1's numbered attendance grid) with a
 *    realistic present/absent/late/online mix;
 *  - two exams on examinable curriculum rows; one has marks entered (§4.2:
 *    pass when score ≥ pass_score, else fail; absent has no score), the other is
 *    left blank so the "pending" grid and the exam picker are both visible.
 */

const DEMO = {
  sectionName: 'قسم العرض التجريبي — بنون',
  subjects: [
    { code: 'DEMO_NAHW', nameAr: 'النحو', mandatory: true },
    { code: 'DEMO_FIQH', nameAr: 'الفقه', mandatory: false },
  ],
  students: [
    'أحمد محمود علي',
    'محمد إبراهيم حسن',
    'يوسف خالد عمر',
    'عبد الله سمير فؤاد',
    'مصطفى ناصر سعيد',
    'كريم وليد فتحي',
  ],
  sessionCount: 12,
  heldCount: 10, // the rest stay "scheduled" with empty columns
};

/** Postgres TIME rides on the Unix epoch in UTC (matches sessions.service). */
function timeOfDay(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00Z`);
}

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
    const actorId =
      (await prisma.users.findFirst({ where: { role: 'head_teacher' }, select: { id: true } }))?.id ??
      null;

    // --- prerequisites: reuse if present, else create the minimum -----------
    const year =
      (await prisma.academic_years.findFirst({ orderBy: { hijri_year: 'desc' } })) ??
      (await prisma.academic_years.create({
        data: {
          hijri_year: 1447,
          starts_on: dateOnly(new Date(), -30),
          ends_on: dateOnly(new Date(), 300),
          status: 'active',
        },
      }));

    const term =
      (await prisma.terms.findFirst({
        where: { academic_year_id: year.id, term_number: 1 },
      })) ??
      (await prisma.terms.create({
        data: {
          academic_year_id: year.id,
          term_number: 1,
          starts_on: dateOnly(new Date(), -30),
          ends_on: dateOnly(new Date(), 120),
          status: 'active',
        },
      }));

    const branch =
      (await prisma.branches.findFirst({ orderBy: { id: 'asc' } })) ??
      (await prisma.branches.create({ data: { name_ar: 'فرع أسوان' } }));

    const level =
      (await prisma.levels.findFirst({ where: { code: 'L1' } })) ??
      (await prisma.levels.findFirst({ orderBy: { sort_order: 'asc' } })) ??
      (await prisma.levels.create({
        data: { code: 'L1', name_ar: 'المستوى الأول', sort_order: 2 },
      }));

    // Demo subjects + examinable curriculum rows for this year/level/term.
    const subjects: Array<{ id: number }> = [];
    const curriculum: Array<{ id: number; pass_score: Prisma.Decimal }> = [];
    for (const s of DEMO.subjects) {
      const subject = await prisma.subjects.upsert({
        where: { code: s.code },
        update: { name_ar: s.nameAr, is_active: true },
        create: { code: s.code, name_ar: s.nameAr },
      });
      subjects.push(subject);
      const existing = await prisma.curriculum.findFirst({
        where: {
          academic_year_id: year.id,
          level_id: level.id,
          subject_id: subject.id,
          term_number: 1,
        },
      });
      const row =
        existing ??
        (await prisma.curriculum.create({
          data: {
            academic_year_id: year.id,
            level_id: level.id,
            subject_id: subject.id,
            term_number: 1,
            is_examinable: true,
            is_mandatory: s.mandatory,
            max_score: 100,
            pass_score: 50,
            weight: 1,
            updated_by: actorId,
          },
        }));
      curriculum.push(row);
    }

    // A year/level absence policy, so the domain is complete if attendance is
    // later saved through the real service.
    if (
      !(await prisma.attendance_policies.findFirst({
        where: { academic_year_id: year.id, level_id: level.id },
      }))
    ) {
      await prisma.attendance_policies.create({
        data: { academic_year_id: year.id, level_id: level.id, updated_by: actorId },
      });
    }

    // --- demo section + students + enrollments (stable, upserted) -----------
    let section = await prisma.sections.findFirst({
      where: {
        branch_id: branch.id,
        academic_year_id: year.id,
        level_id: level.id,
        gender: 'male',
        name: DEMO.sectionName,
      },
    });
    section ??= await prisma.sections.create({
      data: {
        branch_id: branch.id,
        academic_year_id: year.id,
        level_id: level.id,
        gender: 'male',
        name: DEMO.sectionName,
      },
    });

    const enrollments: Array<{ id: string }> = [];
    const demoStudents: Array<{ id: string }> = [];
    for (let i = 0; i < DEMO.students.length; i++) {
      const code = `DEMO-${String(i + 1).padStart(4, '0')}`;
      let student = await prisma.students.findFirst({ where: { student_code: code } });
      student ??= await prisma.students.create({
        data: {
          student_code: code,
          full_name: DEMO.students[i],
          gender: 'male',
          branch_id: branch.id,
          // A phone + opt-in so the absence-warning feature can actually message.
          phone: `+20101234560${i}`,
          whatsapp_opt_in: true,
          created_by: actorId,
        },
      });
      demoStudents.push(student);
      let enrollment = await prisma.enrollments.findFirst({
        where: { student_id: student.id, academic_year_id: year.id },
      });
      enrollment ??= await prisma.enrollments.create({
        data: {
          student_id: student.id,
          section_id: section.id,
          academic_year_id: year.id,
          branch_id: branch.id,
          gender: 'male',
          status: 'active',
          created_by: actorId,
        },
      });
      enrollments.push(enrollment);
    }

    // --- rebuild the churny demo data (sessions/attendance/exams) -----------
    await resetDemoDynamic(prisma, section.id, curriculum.map((c) => c.id));
    await seedSessionsAndAttendance(prisma, section.id, term, subjects, enrollments, actorId);
    const exams = await seedExamsAndScores(
      prisma,
      branch.id,
      year.id,
      term.id,
      curriculum,
      enrollments,
      actorId,
    );

    // --- supporting data so every screen has something to show --------------
    const geo = await seedGeography(prisma);
    await prisma.students.updateMany({
      where: { student_code: { startsWith: 'DEMO-' } },
      data: { governorate_id: geo.governorateId, markaz_id: geo.markazId },
    });
    const girls = await seedGirlsCohort(prisma, branch.id, year.id, level.id, actorId);
    const unenrolled = await seedUnenrolledStudents(prisma, branch.id, actorId);
    await seedTemplates(prisma);
    await seedPlacement(prisma, demoStudents[0].id, level.id, actorId);
    await seedTimetableSlot(prisma, section.id, subjects[0].id, actorId);
    await seedCertificate(prisma, demoStudents[1].id, level.id, enrollments[1].id, branch.id, year.id, actorId);

    console.log('Demo data ready:');
    console.log('  section  :', section.name, `(${section.id})`);
    console.log('  students :', enrollments.length, `(codes DEMO-0001..DEMO-${String(enrollments.length).padStart(4, '0')})`);
    console.log('  girls    :', girls, 'enrolled in a female section (for the group filter)');
    console.log('  unenrolled:', unenrolled, 'students with NO year (test "assign study year" on their profile)');
    console.log('  sessions :', DEMO.sessionCount, `(${DEMO.heldCount} held with attendance)`);
    console.log('  term     : id', term.id, '— pick this term on the attendance page');
    console.log('  exams    :', exams.map((e) => e.id).join(', '));
    console.log('  extras   : placement, timetable slot, one issued certificate, message templates');
    console.log('  note     : DEMO-0004 has 4 absences → "over the limit" on the roster + profile');
  } finally {
    await prisma.$disconnect();
  }
}

/** Deletes only this demo's sessions/attendance and exams/eligibility/results,
 *  in FK-safe order, so a re-run starts clean without touching real data. */
async function resetDemoDynamic(
  prisma: PrismaClient,
  sectionId: string,
  curriculumIds: number[],
): Promise<void> {
  const sessions = await prisma.sessions.findMany({
    where: { section_id: sectionId },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);
  await prisma.attendance.deleteMany({ where: { session_id: { in: sessionIds } } });
  await prisma.sessions.deleteMany({ where: { section_id: sectionId } });

  const exams = await prisma.exams.findMany({
    where: { curriculum_id: { in: curriculumIds } },
    select: { id: true },
  });
  const examIds = exams.map((e) => e.id);
  await prisma.exam_results.deleteMany({ where: { exam_id: { in: examIds } } });
  await prisma.exam_eligibility.deleteMany({ where: { exam_id: { in: examIds } } });
  await prisma.exams.deleteMany({ where: { id: { in: examIds } } });
}

async function seedSessionsAndAttendance(
  prisma: PrismaClient,
  sectionId: string,
  term: { starts_on: Date; ends_on: Date },
  subjects: Array<{ id: number }>,
  enrollments: Array<{ id: string }>,
  actorId: string | null,
): Promise<void> {
  const modes = ['onsite', 'onsite', 'online', 'hybrid'] as const;
  // Spread the sessions evenly across the term so they all fall in its range.
  const span = Math.max(
    1,
    Math.floor(
      (term.ends_on.getTime() - term.starts_on.getTime()) / (86_400_000 * (DEMO.sessionCount + 1)),
    ),
  );

  for (let j = 0; j < DEMO.sessionCount; j++) {
    const held = j < DEMO.heldCount;
    const mode = modes[j % modes.length];
    const session = await prisma.sessions.create({
      data: {
        section_id: sectionId,
        subject_id: subjects[j % subjects.length].id,
        session_no: j + 1,
        session_date: dateOnly(term.starts_on, span * (j + 1)),
        starts_at: timeOfDay('09:00'),
        ends_at: timeOfDay('10:30'),
        mode,
        // DDL: an online (or partly-online hybrid) session needs a meeting link
        // unless cancelled — sessions_check1.
        meeting_url:
          mode === 'onsite' ? null : 'https://meet.example.com/furqan-demo',
        status: held ? 'held' : 'scheduled',
        created_by: actorId,
      },
    });
    if (!held) continue; // future sessions render as empty columns

    await prisma.attendance.createMany({
      data: enrollments.map((enrollment, i) => {
        const status =
          i === 3 && j % 3 === 0
            ? 'absent'
            : i === 1 && j % 4 === 0
              ? 'late'
              : 'present';
        const attendedMode =
          status === 'absent'
            ? null
            : mode === 'online' || (mode === 'hybrid' && i % 2 === 0)
              ? 'online'
              : 'onsite';
        return {
          session_id: session.id,
          enrollment_id: enrollment.id,
          status,
          attended_mode: attendedMode,
          minutes_late: status === 'late' ? 10 : null,
          recorded_by: actorId,
        };
      }),
    });
  }
}

async function seedExamsAndScores(
  prisma: PrismaClient,
  branchId: number,
  academicYearId: number,
  termId: number,
  curriculum: Array<{ id: number; pass_score: Prisma.Decimal }>,
  enrollments: Array<{ id: string }>,
  actorId: string | null,
): Promise<Array<{ id: string }>> {
  // §4.2: pass when score ≥ pass_score, fail below, absent has no score. A
  // spread that shows all three outcomes; one student is marked absent.
  const scores: Array<number | null> = [85, 42, 68, 30, null, 55];
  const created: Array<{ id: string }> = [];

  for (let k = 0; k < curriculum.length; k++) {
    const row = curriculum[k];
    const exam = await prisma.exams.create({
      data: {
        branch_id: branchId,
        academic_year_id: academicYearId,
        term_id: termId,
        curriculum_id: row.id,
        gender: 'male',
        exam_type: 'term_1',
        scheduled_at: new Date(),
        duration_min: 90,
        venue: 'قاعة 1',
        created_by: actorId,
      },
    });
    created.push({ id: exam.id });

    await prisma.exam_eligibility.createMany({
      data: enrollments.map((enrollment) => ({
        exam_id: exam.id,
        enrollment_id: enrollment.id,
        is_eligible: true,
        reason_code: 'new',
      })),
    });

    // Only the first exam gets marks; the second stays blank (pending grid).
    if (k !== 0) continue;
    const passScore = row.pass_score.toNumber();
    await prisma.exam_results.createMany({
      data: enrollments.map((enrollment, i) => {
        const score = scores[i % scores.length];
        const isAbsent = score === null;
        const result = isAbsent ? 'absent' : score >= passScore ? 'pass' : 'fail';
        return {
          exam_id: exam.id,
          enrollment_id: enrollment.id,
          score,
          is_absent: isAbsent,
          result,
          entered_by: actorId,
        };
      }),
    });
  }
  return created;
}

const DEMO_GIRLS_SECTION = 'قسم العرض التجريبي — بنات';

/** A governorate + markaz so the profile shows a location and the dashboard's
 *  "students by markaz" chart has a bar. Idempotent by name. */
async function seedGeography(
  prisma: PrismaClient,
): Promise<{ governorateId: number; markazId: number }> {
  const gov = await prisma.governorates.upsert({
    where: { name_ar: 'أسوان' },
    update: {},
    create: { name_ar: 'أسوان' },
  });
  let markaz = await prisma.markazes.findFirst({
    where: { governorate_id: gov.id, name_ar: 'مركز أسوان' },
  });
  markaz ??= await prisma.markazes.create({
    data: { governorate_id: gov.id, name_ar: 'مركز أسوان' },
  });
  return { governorateId: gov.id, markazId: markaz.id };
}

/** A female section + a few enrolled girls, so the roster's group filter (R3
 *  gender segregation) has both groups to show. */
async function seedGirlsCohort(
  prisma: PrismaClient,
  branchId: number,
  yearId: number,
  levelId: number,
  actorId: string | null,
): Promise<number> {
  const names = ['فاطمة أحمد سالم', 'مريم سعيد حسن', 'عائشة محمود علي'];
  let section = await prisma.sections.findFirst({
    where: { branch_id: branchId, academic_year_id: yearId, level_id: levelId, gender: 'female', name: DEMO_GIRLS_SECTION },
  });
  section ??= await prisma.sections.create({
    data: { branch_id: branchId, academic_year_id: yearId, level_id: levelId, gender: 'female', name: DEMO_GIRLS_SECTION },
  });

  for (let i = 0; i < names.length; i++) {
    const code = `DEMO-F${String(i + 1).padStart(3, '0')}`;
    let student = await prisma.students.findFirst({ where: { student_code: code } });
    student ??= await prisma.students.create({
      data: {
        student_code: code,
        full_name: names[i],
        gender: 'female',
        branch_id: branchId,
        phone: `+20109876540${i}`,
        whatsapp_opt_in: true,
        created_by: actorId,
      },
    });
    const enrolled = await prisma.enrollments.findFirst({
      where: { student_id: student.id, academic_year_id: yearId },
    });
    if (!enrolled) {
      await prisma.enrollments.create({
        data: { student_id: student.id, section_id: section.id, academic_year_id: yearId, branch_id: branchId, gender: 'female', status: 'active', created_by: actorId },
      });
    }
  }
  return names.length;
}

/** Students with no enrollment — the legacy-import case: their year is unknown
 *  until "assign study year" is used on their profile. */
async function seedUnenrolledStudents(
  prisma: PrismaClient,
  branchId: number,
  actorId: string | null,
): Promise<number> {
  const names = ['طالب بلا سنة (تجريبي أ)', 'طالب بلا سنة (تجريبي ب)'];
  for (let i = 0; i < names.length; i++) {
    const code = `DEMO-U${String(i + 1).padStart(3, '0')}`;
    if (!(await prisma.students.findFirst({ where: { student_code: code } }))) {
      await prisma.students.create({
        data: { student_code: code, full_name: names[i], gender: 'male', branch_id: branchId, created_by: actorId },
      });
    }
  }
  return names.length;
}

/** The templates the WhatsApp screen lists and the absence-warning path renders. */
async function seedTemplates(prisma: PrismaClient): Promise<void> {
  await prisma.message_templates.upsert({
    where: { code: 'absence_warning' },
    update: {},
    create: {
      code: 'absence_warning',
      body: 'تنبيه: بلغ غياب الطالب {{student_name}} عددًا قدره {{count}} من {{max}} مسموح. نرجو المتابعة.',
      is_active: true,
    },
  });
  await prisma.message_templates.upsert({
    where: { code: 'friday_reminder' },
    update: {},
    create: {
      code: 'friday_reminder',
      body: 'تذكير: حصة يوم الجمعة للطالب {{student_name}} في تمام الساعة التاسعة صباحًا.',
      is_active: true,
    },
  });
}

/** One placement assessment, so the profile's placements panel is populated. */
async function seedPlacement(
  prisma: PrismaClient,
  studentId: string,
  levelId: number,
  actorId: string | null,
): Promise<void> {
  if (await prisma.placement_assessments.findFirst({ where: { student_id: studentId } })) return;
  await prisma.placement_assessments.create({
    data: {
      student_id: studentId,
      method: 'entrance_exam',
      score: 42,
      max_score: 50,
      pass_score: 25,
      is_passed: true,
      placed_level_id: levelId,
      notes: 'اختبار تحديد مستوى تجريبي',
      created_by: actorId,
    },
  });
}

/** A Friday timetable slot, so the timetable editor shows a slot to edit. */
async function seedTimetableSlot(
  prisma: PrismaClient,
  sectionId: string,
  subjectId: number,
  actorId: string | null,
): Promise<void> {
  if (await prisma.timetable_slots.findFirst({ where: { section_id: sectionId } })) return;
  await prisma.timetable_slots.create({
    data: {
      section_id: sectionId,
      subject_id: subjectId,
      weekday: 5,
      slot_order: 1,
      starts_at: timeOfDay('09:00'),
      ends_at: timeOfDay('10:30'),
      room: 'قاعة 1',
      updated_by: actorId,
    },
  });
}

/** One issued certificate, so the certificates screen has a row. `issued_by` is
 *  NOT NULL, so this is skipped when there is no head teacher to attribute it. */
async function seedCertificate(
  prisma: PrismaClient,
  studentId: string,
  levelId: number,
  enrollmentId: string,
  branchId: number,
  yearId: number,
  actorId: string | null,
): Promise<void> {
  if (!actorId) return;
  if (await prisma.certificates.findFirst({ where: { student_id: studentId } })) return;
  await prisma.certificates.create({
    data: {
      student_id: studentId,
      level_id: levelId,
      enrollment_id: enrollmentId,
      academic_year_id: yearId,
      branch_id: branchId,
      serial_no: `DEMO-CERT-${Date.now()}`,
      issued_by: actorId,
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
