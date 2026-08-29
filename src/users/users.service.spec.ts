import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { users as UserRecord } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { IPasswordHasher } from '../auth/interfaces/password-hasher.interface';
import type { Actor } from '../common/actor.decorator';
import { AuditEntry, AuditService } from '../common/audit.service';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

const ASWAN = 1;
const CAIRO = 2;

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    full_name: 'أحمد مصطفى',
    username: 'headteacher',
    gender: 'male',
    phone: '+201001234567',
    email: null,
    password_hash: 'stored-hash',
    role: 'head_teacher',
    branch_id: ASWAN,
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

const INSTITUTE_WIDE: AuthenticatedUser = {
  id: 'viewer',
  role: 'head_teacher',
  branchId: null,
};
const ASWAN_ONLY: AuthenticatedUser = {
  id: 'viewer',
  role: 'head_teacher',
  branchId: ASWAN,
};
const ACTOR: Actor = { userId: 'viewer', ipAddress: '127.0.0.1' };

function buildService(stored: UserRecord | null) {
  // Mocked at the boundaries only: the repository is the database, the audit
  // service writes to it, and the hasher is bcrypt (real cost-12 hashing would
  // add a quarter second per assertion and cover nothing extra).
  const create = jest.fn((data: Record<string, unknown>) =>
    Promise.resolve(userRecord({ id: 'created', ...data })),
  );
  const softDelete = jest.fn(() => Promise.resolve(userRecord()));
  const recordAudit = jest.fn<Promise<void>, [Actor, AuditEntry]>();
  const hash = jest.fn(() => Promise.resolve('bcrypt-output'));

  const repository = {
    findById: jest.fn(() => Promise.resolve(stored)),
    create,
    update: jest.fn((id: string, data: Record<string, unknown>) =>
      Promise.resolve(userRecord({ id, ...data })),
    ),
    softDelete,
  } as unknown as UsersRepository;
  const audit = { record: recordAudit } as unknown as AuditService;
  const hasher = { hash, verify: jest.fn() } as unknown as IPasswordHasher;

  return {
    service: new UsersService(repository, audit, hasher),
    create,
    softDelete,
    recordAudit,
    hash,
  };
}

describe('UsersService.getProfile', () => {
  it('returns the public projection, without the password hash', async () => {
    const { service } = buildService(userRecord());

    const profile = await service.getProfile('user-1');

    expect(profile).toEqual({
      id: 'user-1',
      fullName: 'أحمد مصطفى',
      username: 'headteacher',
      gender: 'male',
      role: 'head_teacher',
      branchId: ASWAN,
      phone: '+201001234567',
      email: null,
      isActive: true,
    });
    expect(profile).not.toHaveProperty('password_hash');
  });

  // A 15-minute access token outlives a mid-window delete or deactivation.
  it.each([
    ['deleted', userRecord({ deleted_at: new Date() })],
    ['deactivated', userRecord({ is_active: false })],
    ['gone', null],
  ])('rejects a token belonging to a %s account', async (_label, stored) => {
    const { service } = buildService(stored);

    await expect(service.getProfile('user-1')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('UsersService.create', () => {
  it('stores the hash the hasher produced and never the plaintext', async () => {
    const { service, create, hash } = buildService(null);

    await service.create(
      {
        fullName: 'فاطمة',
        username: 'fatima',
        gender: 'female',
        phone: '+201009998888',
        password: 'plaintext-secret',
        role: 'teacher',
        branchId: ASWAN,
      },
      ACTOR,
    );

    expect(hash).toHaveBeenCalledWith('plaintext-secret');
    const [data] = create.mock.calls[0];
    expect(data.password_hash).toBe('bcrypt-output');
    expect(JSON.stringify(data)).not.toContain('plaintext-secret');
  });
});

describe('UsersService branch scoping', () => {
  it('lets an institute-wide head teacher read a user in any branch', async () => {
    const { service } = buildService(userRecord({ branch_id: CAIRO }));

    await expect(service.getById('user-1', INSTITUTE_WIDE)).resolves.toEqual(
      expect.objectContaining({ branchId: CAIRO }),
    );
  });

  it('stops a branch-scoped head teacher reading another branch', async () => {
    const { service } = buildService(userRecord({ branch_id: CAIRO }));

    await expect(service.getById('user-1', ASWAN_ONLY)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it.each([
    ['a missing user', null],
    ['an already-deleted user', userRecord({ deleted_at: new Date() })],
  ])('reports %s as not found', async (_label, stored) => {
    const { service } = buildService(stored);

    await expect(service.getById('user-1', INSTITUTE_WIDE)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('UsersService.softDelete', () => {
  it('refuses to delete the account making the request', async () => {
    const { service, softDelete } = buildService(
      userRecord({ id: ACTOR.userId }),
    );

    await expect(
      service.softDelete(
        ACTOR.userId,
        'left the institute',
        ACTOR,
        INSTITUTE_WIDE,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it('records the pre-deletion state so the audit log can reconstruct it', async () => {
    const { service, recordAudit } = buildService(userRecord({ id: 'victim' }));

    await service.softDelete(
      'victim',
      'left the institute',
      ACTOR,
      INSTITUTE_WIDE,
    );

    const [auditedActor, entry] = recordAudit.mock.calls[0];
    expect(auditedActor).toBe(ACTOR);
    expect(entry).toMatchObject({
      action: 'user.delete',
      entityId: 'victim',
      after: { deleteReason: 'left the institute' },
    });
    // The point of audit_logs.before: the row is reconstructable afterwards.
    expect(entry.before).toMatchObject({ username: 'headteacher' });
  });
});
