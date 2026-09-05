import type { Actor } from '../common/actor.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CampaignsService } from './campaigns.service';

const VIEWER: AuthenticatedUser = { id: 'v', role: 'head_teacher', branchId: null };
const ACTOR: Actor = { userId: 'v', ipAddress: '127.0.0.1' };

/* The manual per-student absence warning (§4.8). Mocked at the boundaries —
   Prisma, the WhatsApp client, the audit log — so the assertions are about the
   branching the method owns: below the warn line it does nothing; at/over it, it
   records the threshold and sends. */
function buildService(absences: number) {
  const enrollment = {
    id: 'e1',
    branch_id: 1,
    academic_year_id: 1,
    section: { level_id: 2 },
    student: {
      id: 's1',
      full_name: 'أحمد سالم',
      phone: '+201000000001',
      whatsapp_phone: null,
      whatsapp_opt_in: true,
    },
  };
  const prisma = {
    enrollments: { findFirst: jest.fn().mockResolvedValue(enrollment) },
    terms: {
      findFirst: jest.fn().mockResolvedValue({
        id: 1,
        starts_on: new Date('2026-01-01'),
        ends_on: new Date('2026-12-31'),
      }),
    },
    attendance_policies: {
      findMany: jest.fn().mockResolvedValue([{ level_id: null, warn_at_absences: 3, max_absences: 4 }]),
    },
    attendance: { count: jest.fn().mockResolvedValue(absences) },
    attendance_warnings: {
      upsert: jest.fn().mockResolvedValue({ id: 'w1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    message_templates: {
      findUnique: jest.fn().mockResolvedValue({
        code: 'absence_warning',
        is_active: true,
        body: 'الطالب {{student_name}} تجاوز {{count}} من {{max}}',
        language: 'ar',
        provider_template_name: null,
      }),
    },
    institute_settings: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, whatsapp_phone_number_id: 'PID' }),
    },
    messages: {
      create: jest.fn().mockResolvedValue({ id: 1n }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const whatsapp = {
    isConfigured: jest.fn().mockReturnValue(true),
    sendTemplate: jest.fn().mockResolvedValue({
      status: 'sent',
      providerMessageId: 'x',
      errorCode: null,
      errorMessage: null,
    }),
  };
  const service = new CampaignsService(
    prisma as unknown as ConstructorParameters<typeof CampaignsService>[0],
    audit as unknown as ConstructorParameters<typeof CampaignsService>[1],
    whatsapp as unknown as ConstructorParameters<typeof CampaignsService>[2],
  );
  return { service, prisma, whatsapp };
}

describe('CampaignsService.warnStudentAbsence', () => {
  it('does nothing for a student below the warn line', async () => {
    const { service, prisma, whatsapp } = buildService(2);

    const result = await service.warnStudentAbsence('s1', ACTOR, VIEWER);

    expect(result).toEqual({ status: 'not_at_risk', absences: 2, threshold: null });
    expect(prisma.attendance_warnings.upsert).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('records the threshold and sends when the student is at/over the limit', async () => {
    const { service, prisma, whatsapp } = buildService(4);

    const result = await service.warnStudentAbsence('s1', ACTOR, VIEWER);

    expect(result).toEqual({ status: 'sent', absences: 4, threshold: 4 });
    // The warning is recorded against the max threshold before the send.
    expect(prisma.attendance_warnings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enrollment_id_term_id_threshold: { enrollment_id: 'e1', term_id: 1, threshold: 4 } },
      }),
    );
    expect(whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
