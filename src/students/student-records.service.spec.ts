import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { StudentRecordsService } from './student-records.service';
import { StudentsService } from './students.service';

const VIEWER: AuthenticatedUser = { id: 'v', role: 'head_teacher', branchId: null };

/* Mocked at the boundaries only: Prisma is the database and StudentsService is
   the visibility gate. The point of these tests is the aggregation/mapping the
   service does on top of the raw rows, which is where a wrong enum, a missing
   toNumber(), or a dropped null would slip through. */
function buildService() {
  const prisma = {
    // findFirst backs absencePosition, which attendanceSummary always calls.
    // Left unstubbed it resolves undefined, so the position reads null — the
    // "no current enrolment" branch, which is what these tests want.
    enrollments: { findMany: jest.fn(), findFirst: jest.fn() },
    academic_years: { findMany: jest.fn() },
    attendance: { count: jest.fn(), findMany: jest.fn() },
    exam_results: { findMany: jest.fn() },
    carried_subjects: { findMany: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const students = { assertVisible: jest.fn().mockResolvedValue(undefined) };
  const service = new StudentRecordsService(
    prisma as unknown as ConstructorParameters<typeof StudentRecordsService>[0],
    students as unknown as StudentsService,
  );
  return { service, prisma, students };
}

describe('StudentRecordsService', () => {
  it('tallies attendance by status and maps the recent window', async () => {
    const { service, prisma } = buildService();
    // The service counts present, absent, late, excused in that order.
    prisma.attendance.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    prisma.attendance.findMany.mockResolvedValue([
      {
        status: 'late',
        attended_mode: 'onsite',
        minutes_late: 5,
        sessions: {
          session_date: new Date('2026-08-20T00:00:00Z'),
          mode: 'onsite',
          sections: { name: 'قسم أ' },
          subjects: { name_ar: 'النحو' },
        },
      },
    ]);

    const out = await service.attendanceSummary('s1', VIEWER);

    // excused had no group row, so it reads 0, and the total is the four summed.
    expect(out).toMatchObject({ present: 10, absent: 2, late: 1, excused: 0, total: 13 });
    expect(out.recent[0]).toMatchObject({
      subjectName: 'النحو',
      sectionName: 'قسم أ',
      status: 'late',
      minutesLate: 5,
    });
    expect(out.recent[0].sessionDate).toBe('2026-08-20');
  });

  it('maps exam results, turning decimals to numbers and keeping an absent null score', async () => {
    const { service, prisma } = buildService();
    const curriculum = {
      term_number: 1,
      max_score: new Prisma.Decimal(100),
      pass_score: new Prisma.Decimal(50),
      subjects: { name_ar: 'النحو' },
    };
    prisma.exam_results.findMany.mockResolvedValue([
      { id: 'r1', score: new Prisma.Decimal(85), is_absent: false, result: 'pass', exams: { exam_type: 'term_1', curriculum } },
      { id: 'r2', score: null, is_absent: true, result: 'absent', exams: { exam_type: 'term_1', curriculum: { ...curriculum, subjects: { name_ar: 'الفقه' } } } },
    ]);

    const out = await service.examResults('s1', VIEWER);

    expect(out[0]).toEqual({
      id: 'r1',
      subjectName: 'النحو',
      termNumber: 1,
      examType: 'term_1',
      score: 85,
      maxScore: 100,
      passScore: 50,
      isAbsent: false,
      result: 'pass',
    });
    expect(out[1].score).toBeNull();
    expect(out[1].isAbsent).toBe(true);
  });

  it('joins each enrollment to its hijri year and tolerates a section with no level', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findMany.mockResolvedValue([
      { id: 'e1', academic_year_id: 5, status: 'active', entry_type: 'new', is_historical: false, section: { id: 'sec1', name: 'قسم أ', levels: { id: 2, name_ar: 'المستوى الأول' } } },
      { id: 'e2', academic_year_id: 4, status: 'completed', entry_type: 'promoted', is_historical: true, section: { id: 'sec0', name: 'قسم قديم', levels: null } },
    ]);
    prisma.academic_years.findMany.mockResolvedValue([
      { id: 5, hijri_year: 1447 },
      { id: 4, hijri_year: 1446 },
    ]);

    const out = await service.enrollmentHistory('s1', VIEWER);

    expect(out[0]).toMatchObject({ academicYearId: 5, hijriYear: 1447, levelId: 2, levelName: 'المستوى الأول', sectionName: 'قسم أ' });
    expect(out[1]).toMatchObject({ hijriYear: 1446, levelId: null, levelName: null });
  });

  it('groups carried subjects by the level that produced them, dated by the year of the failure', async () => {
    const { service, prisma } = buildService();
    prisma.enrollments.findMany.mockResolvedValue([{ id: 'enr-l3' }]);
    // The case the head teacher describes: a student sitting المستوى الثالث who
    // still owes one subject from the first level and two from the second.
    const fromYear = (id: number) => ({
      enrollments_carried_subjects_from_enrollment_idToenrollments: {
        academic_year_id: id,
      },
    });
    prisma.carried_subjects.findMany.mockResolvedValue([
      { subject_id: 7, status: 'pending', cleared_at: null, origin_level_id: 2, subjects: { name_ar: 'النحو' }, levels: { name_ar: 'المستوى الأول' }, ...fromYear(4) },
      { subject_id: 9, status: 'pending', cleared_at: null, origin_level_id: 3, subjects: { name_ar: 'الفقه' }, levels: { name_ar: 'المستوى الثاني' }, ...fromYear(5) },
      { subject_id: 11, status: 'cleared', cleared_at: new Date('2026-05-01T00:00:00Z'), origin_level_id: 3, subjects: { name_ar: 'التفسير' }, levels: { name_ar: 'المستوى الثاني' }, ...fromYear(5) },
    ]);
    prisma.academic_years.findMany.mockResolvedValue([
      { id: 4, hijri_year: 1446 },
      { id: 5, hijri_year: 1447 },
    ]);

    const out = await service.carriedSubjects('s1', VIEWER);

    expect(out).toEqual([
      {
        originLevelId: 2,
        originLevelName: 'المستوى الأول',
        originHijriYear: 1446,
        subjects: [{ subjectId: 7, subjectName: 'النحو', status: 'pending', clearedAt: null }],
      },
      {
        originLevelId: 3,
        originLevelName: 'المستوى الثاني',
        originHijriYear: 1447,
        subjects: [
          { subjectId: 9, subjectName: 'الفقه', status: 'pending', clearedAt: null },
          { subjectId: 11, subjectName: 'التفسير', status: 'cleared', clearedAt: '2026-05-01T00:00:00.000Z' },
        ],
      },
    ]);
  });

  it('refuses a student outside the viewer’s scope before any record query', async () => {
    const { service, prisma, students } = buildService();
    students.assertVisible.mockRejectedValue(new NotFoundException());

    await expect(service.examResults('hidden', VIEWER)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.exam_results.findMany).not.toHaveBeenCalled();
  });
});
