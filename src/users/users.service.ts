import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, users as UserRecord } from '@prisma/client';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { buildPage, Page } from '../common/pagination';
import { PASSWORD_HASHER } from '../auth/interfaces/password-hasher.interface';
import type { IPasswordHasher } from '../auth/interfaces/password-hasher.interface';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto/user.schema';
import { PrismaService } from '../prisma/prisma.service';
import { PublicUser, toPublicUser } from './users.mapper';
import { UsersRepository } from './users.repository';

const ENTITY_TYPE = 'user';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: IPasswordHasher,
  ) {}

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.usersRepository.findById(userId);
    // An access token stays valid for its full 15 minutes, so it outlives a
    // soft delete or a deactivation performed mid-window. Re-checking here is
    // what closes that window; the token alone is not proof of a live account.
    if (!user || user.deleted_at || !user.is_active) {
      throw new UnauthorizedException('Account no longer active');
    }
    return toPublicUser(user);
  }

  async list(
    query: ListUsersQueryDto,
    viewer: AuthenticatedUser,
  ): Promise<Page<PublicUser>> {
    const { rows, total } = await this.usersRepository.list({
      ...query,
      actorBranchId: viewer.branchId,
    });
    return buildPage(rows.map(toPublicUser), total, query);
  }

  async getById(id: string, viewer: AuthenticatedUser): Promise<PublicUser> {
    return toPublicUser(await this.findVisible(id, viewer));
  }

  async create(dto: CreateUserDto, actor: Actor): Promise<PublicUser> {
    const created = await this.createRecord(dto);

    await this.audit.record(actor, {
      action: 'user.create',
      entityType: ENTITY_TYPE,
      entityId: created.id,
      after: toPublicUser(created),
    });
    return toPublicUser(created);
  }

  /** Insert, turning a unique-constraint collision (email, username or phone —
   *  all three are unique and all three are now login-relevant) into a 409 that
   *  names the field, instead of a raw 500. */
  private async createRecord(dto: CreateUserDto): Promise<UserRecord> {
    try {
      return await this.usersRepository.create({
        full_name: dto.fullName,
        username: dto.username,
        gender: dto.gender,
        phone: dto.phone,
        email: dto.email,
        password_hash: await this.passwordHasher.hash(dto.password),
        role: dto.role,
        ...(dto.branchId === null
          ? {}
          : { branches: { connect: { id: dto.branchId } } }),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const fields = (error.meta?.target as string[] | undefined) ?? [];
        const field = fields.includes('email')
          ? 'email'
          : fields.includes('username')
            ? 'username'
            : 'phone';
        throw new ConflictException(`That ${field} is already in use`);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<PublicUser> {
    const before = await this.findVisible(id, viewer);
    const updated = await this.usersRepository.update(id, {
      ...(dto.fullName === undefined ? {} : { full_name: dto.fullName }),
      ...(dto.phone === undefined ? {} : { phone: dto.phone }),
      ...(dto.email === undefined ? {} : { email: dto.email }),
      ...(dto.role === undefined ? {} : { role: dto.role }),
      ...(dto.isActive === undefined ? {} : { is_active: dto.isActive }),
      ...(dto.branchId === undefined
        ? {}
        : {
            branches:
              dto.branchId === null
                ? { disconnect: true }
                : { connect: { id: dto.branchId } },
          }),
      updated_at: new Date(),
    });

    await this.audit.record(actor, {
      action: 'user.update',
      entityType: ENTITY_TYPE,
      entityId: id,
      before: toPublicUser(before),
      after: toPublicUser(updated),
    });
    return toPublicUser(updated);
  }

  // R9: soft delete, head teacher only (enforced by @Roles on the route), and
  // the reason is mandatory.
  async softDelete(
    id: string,
    reason: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<void> {
    if (id === actor.userId) {
      // The head teacher is the only account that can restore another one, so
      // deleting yourself can lock the institute out of its own system.
      throw new BadRequestException('You cannot delete your own account');
    }
    const before = await this.findVisible(id, viewer);
    await this.usersRepository.softDelete(id, actor.userId, reason);

    await this.audit.record(actor, {
      action: 'user.delete',
      entityType: ENTITY_TYPE,
      entityId: id,
      before: toPublicUser(before),
      after: { deleteReason: reason },
    });
  }

  /**
   * F10: a user changes their own password. The current password is required,
   * so a stolen access token alone cannot be used to seize the account by
   * resetting its password. Every other refresh session is revoked, so a token
   * the attacker already holds stops working the moment the real owner rotates.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    actor: Actor,
  ): Promise<void> {
    const user = await this.usersRepository.findById(userId);
    if (!user || user.deleted_at || !user.is_active) {
      throw new UnauthorizedException('Account no longer active');
    }
    const valid = await this.passwordHasher.verify(
      currentPassword,
      user.password_hash,
    );
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.setPassword(userId, newPassword);
    await this.audit.record(actor, {
      action: 'user.password.change',
      entityType: ENTITY_TYPE,
      entityId: userId,
    });
  }

  /**
   * F10: the head teacher resets another user's password without recreating the
   * account — the path for a compromised or forgotten teacher credential. All
   * of that user's sessions are revoked.
   */
  async resetPassword(
    id: string,
    newPassword: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<void> {
    const user = await this.findVisible(id, viewer);
    await this.setPassword(user.id, newPassword);
    await this.audit.record(actor, {
      action: 'user.password.reset',
      entityType: ENTITY_TYPE,
      entityId: id,
    });
  }

  private async setPassword(
    userId: string,
    newPassword: string,
  ): Promise<void> {
    const password_hash = await this.passwordHasher.hash(newPassword);
    await this.usersRepository.update(userId, {
      password_hash,
      failed_logins: 0,
      locked_until: null,
      updated_at: new Date(),
    });
    // A password change ends every existing session: any refresh token still
    // out there (including one an attacker holds) is revoked, so it cannot mint
    // fresh access tokens after the rotation.
    await this.prisma.refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  // One lookup that answers both "does it exist" and "is this viewer allowed
  // to see it", so no caller can accidentally check only the first.
  private async findVisible(
    id: string,
    viewer: AuthenticatedUser,
  ): Promise<UserRecord> {
    const user = await this.usersRepository.findById(id);
    if (!user || user.deleted_at) {
      throw new NotFoundException('User not found');
    }
    if (viewer.branchId !== null && user.branch_id !== viewer.branchId) {
      // Deliberately 403 rather than 404: the caller is a head teacher, so
      // "this user exists but is not yours" is not information worth hiding
      // from them, and a 404 here would send them hunting for a typo.
      throw new ForbiddenException('User belongs to another branch');
    }
    return user;
  }
}
