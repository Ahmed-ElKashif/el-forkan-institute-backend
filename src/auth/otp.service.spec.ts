import type { otp_challenges as OtpChallenge } from '@prisma/client';
import type { IPasswordHasher } from './interfaces/password-hasher.interface';
import { OtpService } from './otp.service';
import { OTP_MAX_ATTEMPTS } from './auth.constants';

function challenge(overrides: Partial<OtpChallenge> = {}): OtpChallenge {
  return {
    id: 'challenge-1',
    user_id: 'user-1',
    purpose: 'login',
    code_hash: 'hash-of-123456',
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    attempts: 0,
    ip_address: null,
    user_agent: null,
    created_at: new Date('2026-09-01'),
    ...overrides,
  };
}

// Mocked at the boundaries only (users.service.spec pattern): otp_challenges is
// the database, the hasher is bcrypt. `verifyReturns` decides whether a guess
// matches, so a test drives the match without paying for real cost-12 hashing.
function buildService(stored: OtpChallenge | null, verifyReturns = true) {
  const findUnique = jest.fn(() => Promise.resolve(stored));
  const create = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve(challenge({ id: 'created', ...args.data })),
  );
  const update = jest.fn(() => Promise.resolve(challenge()));
  const updateMany = jest.fn(() => Promise.resolve({ count: 1 }));
  const prisma = {
    otp_challenges: { findUnique, create, update, updateMany },
  };
  const hasher: IPasswordHasher = {
    hash: jest.fn(() => Promise.resolve('bcrypt-output')),
    verify: jest.fn(() => Promise.resolve(verifyReturns)),
  };
  const service = new OtpService(prisma as never, hasher);
  return { service, findUnique, create, update, updateMany, hasher };
}

describe('OtpService.issue', () => {
  it('retires prior codes and stores a hash of a fresh six-digit code', async () => {
    const { service, create, updateMany, hasher } = buildService(null);

    const { challengeId, code } = await service.issue('user-1', 'login', {});

    expect(updateMany).toHaveBeenCalledTimes(1); // prior unconsumed retired
    expect(code).toMatch(/^\d{6}$/);
    expect(hasher.hash).toHaveBeenCalledWith(code);
    // The raw code never reaches the row — only its hash, tagged with purpose.
    const stored = create.mock.calls[0][0].data as {
      code_hash: string;
      purpose: string;
    };
    expect(stored.code_hash).toBe('bcrypt-output');
    expect(stored.purpose).toBe('login');
    expect(challengeId).toBe('created');
  });
});

describe('OtpService.verify', () => {
  it('returns the user id and consumes the challenge on the right code', async () => {
    const { service, update } = buildService(challenge(), true);

    const userId = await service.verify('challenge-1', '123456', 'login');

    expect(userId).toBe('user-1');
    expect(update.mock.calls[0][0].data).toEqual({ consumed_at: expect.any(Date) });
  });

  it('returns null and spends one attempt on a wrong code', async () => {
    const { service, update } = buildService(challenge(), false);

    const userId = await service.verify('challenge-1', '000000', 'login');

    expect(userId).toBeNull();
    expect(update.mock.calls[0][0].data).toEqual({ attempts: { increment: 1 } });
  });

  /* A reset code must never satisfy a login (it is issued on email alone, with
     no password), so a purpose mismatch is rejected before the code is checked. */
  it('rejects a code presented for the wrong purpose', async () => {
    const { service, update, hasher } = buildService(challenge({ purpose: 'password_reset' }), true);

    const userId = await service.verify('challenge-1', '123456', 'login');

    expect(userId).toBeNull();
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    ['expired', challenge({ expires_at: new Date(Date.now() - 1) })],
    ['already consumed', challenge({ consumed_at: new Date() })],
    ['out of attempts', challenge({ attempts: OTP_MAX_ATTEMPTS })],
  ])('rejects a %s challenge without checking the code', async (_label, stored) => {
    const { service, update, hasher } = buildService(stored, true);

    const userId = await service.verify('challenge-1', '123456', 'login');

    expect(userId).toBeNull();
    expect(hasher.verify).not.toHaveBeenCalled(); // short-circuits before bcrypt
    expect(update).not.toHaveBeenCalled(); // dead challenge is not mutated
  });
});
