import { UnauthorizedException } from '@nestjs/common';
import type { users as UserRecord } from '@prisma/client';
import type { IPasswordHasher } from './interfaces/password-hasher.interface';
import type { ITokenService } from './interfaces/token.service.interface';
import type { IEmailSender } from './interfaces/email-sender.interface';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    full_name: 'أحمد مصطفى',
    username: 'ahmad',
    gender: 'male',
    phone: '+201001234567',
    email: 'ahmad@example.com',
    password_hash: 'stored-hash',
    role: 'head_teacher',
    branch_id: 1,
    is_active: true,
    failed_logins: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    ...overrides,
  };
}

// Boundaries mocked (the repository and prisma are the database, the hasher is
// bcrypt, the token service is JWT, the email sender is Resend). OtpService is
// a real collaborator wired to the same fake DB — the flow under test spans
// both, and mocking it would hide exactly the password→challenge→code seam
// these tests exist to prove.
function buildService(options: {
  storedUser: UserRecord | null;
  passwordValid: boolean;
  challengePurpose?: 'login' | 'password_reset';
}) {
  const findByEmail = jest.fn(() => Promise.resolve(options.storedUser));
  const findById = jest.fn(() => Promise.resolve(options.storedUser));
  const usersRepository = { findByEmail, findById };

  const created = { id: 'challenge-created' };
  const liveChallenge = {
    id: 'challenge-created',
    user_id: 'user-1',
    purpose: options.challengePurpose ?? 'login',
    code_hash: 'bcrypt-output',
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    attempts: 0,
  };
  const usersUpdate = jest.fn((_args: { data: Record<string, unknown> }) => Promise.resolve(options.storedUser));
  const tokensRevoke = jest.fn(() => Promise.resolve({ count: 1 }));
  const prisma = {
    users: { update: usersUpdate },
    refresh_tokens: {
      create: jest.fn(() => Promise.resolve({})),
      updateMany: tokensRevoke,
    },
    otp_challenges: {
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      create: jest.fn(() => Promise.resolve(created)),
      findUnique: jest.fn(() => Promise.resolve(liveChallenge)),
      update: jest.fn(() => Promise.resolve(liveChallenge)),
    },
  };

  const hasher: IPasswordHasher = {
    hash: jest.fn(() => Promise.resolve('bcrypt-output')),
    verify: jest.fn(() => Promise.resolve(options.passwordValid)),
  };
  const tokenService: ITokenService = {
    signAccessToken: jest.fn(() => 'access-token'),
    verifyAccessToken: jest.fn(),
    generateRefreshToken: jest.fn(() => ({ token: 'raw', tokenHash: 'hash' })),
    hashRefreshToken: jest.fn(() => 'hash'),
  };
  const emailSender: IEmailSender = { sendOtp: jest.fn(() => Promise.resolve()) };

  const otpService = new OtpService(prisma as never, hasher);
  const service = new AuthService(
    prisma as never,
    usersRepository as never,
    otpService,
    hasher,
    tokenService,
    emailSender,
  );
  return { service, emailSender, tokenService, usersUpdate, tokensRevoke, hasher };
}

describe('AuthService.beginLogin', () => {
  it('emails a code and returns a challenge instead of a session on the right password', async () => {
    const { service, emailSender, tokenService } = buildService({
      storedUser: userRecord(),
      passwordValid: true,
    });

    const result = await service.beginLogin('ahmad@example.com', 'pw', {});

    expect(result).toEqual({ mfaRequired: true, challengeId: 'challenge-created' });
    // A password alone must open no session — no token is minted at this step.
    expect(tokenService.generateRefreshToken).not.toHaveBeenCalled();
    const emailed = (emailSender.sendOtp as jest.Mock).mock.calls[0][0];
    expect(emailed).toMatchObject({ to: 'ahmad@example.com', purpose: 'login' });
    expect(emailed.code).toMatch(/^\d{6}$/);
  });

  it('rejects an unknown email with a generic 401 and sends no code', async () => {
    const { service, emailSender } = buildService({
      storedUser: null,
      passwordValid: false,
    });

    await expect(
      service.beginLogin('nobody@example.com', 'pw', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(emailSender.sendOtp).not.toHaveBeenCalled();
  });
});

describe('AuthService.requestPasswordReset', () => {
  it('emails a reset code for a real account', async () => {
    const { service, emailSender } = buildService({
      storedUser: userRecord(),
      passwordValid: true,
    });

    const result = await service.requestPasswordReset('ahmad@example.com', {});

    expect(result.challengeId).toBe('challenge-created');
    const emailed = (emailSender.sendOtp as jest.Mock).mock.calls[0][0];
    expect(emailed).toMatchObject({ to: 'ahmad@example.com', purpose: 'password_reset' });
  });

  /* An unknown email must be indistinguishable from a real one — same 200 with
     a challenge id — or the endpoint becomes an account-enumeration oracle. */
  it('returns a challenge id but sends nothing for an unknown email', async () => {
    const { service, emailSender } = buildService({
      storedUser: null,
      passwordValid: false,
    });

    const result = await service.requestPasswordReset('nobody@example.com', {});

    expect(result.challengeId).toEqual(expect.any(String));
    expect(emailSender.sendOtp).not.toHaveBeenCalled();
  });
});

describe('AuthService.confirmPasswordReset', () => {
  it('sets a new password hash and revokes every refresh token on a valid code', async () => {
    const { service, usersUpdate, tokensRevoke, hasher } = buildService({
      storedUser: userRecord(),
      passwordValid: true, // OtpService's hasher.verify → the code matches
      challengePurpose: 'password_reset',
    });

    await service.confirmPasswordReset('challenge-created', '123456', 'a-brand-new-password');

    expect(hasher.hash).toHaveBeenCalledWith('a-brand-new-password');
    expect(usersUpdate.mock.calls[0][0].data).toMatchObject({
      password_hash: 'bcrypt-output',
      failed_logins: 0,
      locked_until: null,
    });
    // Any session opened with the old password is ended.
    expect(tokensRevoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong reset code with a generic 401', async () => {
    const { service, tokensRevoke } = buildService({
      storedUser: userRecord(),
      passwordValid: false,
      challengePurpose: 'password_reset',
    });

    await expect(
      service.confirmPasswordReset('challenge-created', '000000', 'a-brand-new-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokensRevoke).not.toHaveBeenCalled();
  });
});

describe('AuthService.verifyOtp', () => {
  it('exchanges a valid code for a session and stamps the login time', async () => {
    const { service, tokenService, usersUpdate } = buildService({
      storedUser: userRecord(),
      passwordValid: true, // drives the hasher.verify used by OtpService
    });

    const result = await service.verifyOtp('challenge-created', '123456', {});

    expect(result.accessToken).toBe('access-token');
    expect(result.user.email).toBe('ahmad@example.com');
    expect(tokenService.generateRefreshToken).toHaveBeenCalledTimes(1);
    expect(usersUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { last_login_at: expect.any(Date) },
    });
  });

  it('rejects a wrong code with a generic 401', async () => {
    const { service } = buildService({
      storedUser: userRecord(),
      passwordValid: false, // OtpService's hasher.verify returns false → no match
    });

    await expect(
      service.verifyOtp('challenge-created', '000000', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
