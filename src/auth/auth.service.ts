import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { users as UserRecord } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersRepository } from '../users/users.repository';
import { PublicUser, toPublicUser } from '../users/users.mapper';
import { PASSWORD_HASHER } from './interfaces/password-hasher.interface';
import type { IPasswordHasher } from './interfaces/password-hasher.interface';
import { TOKEN_SERVICE } from './interfaces/token.service.interface';
import type { ITokenService } from './interfaces/token.service.interface';
import {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_LOGINS,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';

// One message for every credential failure — an unknown user, a wrong password
// and a locked account are indistinguishable to the caller (F9).
const INVALID_CREDENTIALS = 'Invalid username or password';

// A valid bcrypt hash (cost 12) of a value no one knows. Comparing against it
// when the username does not exist makes the failed-login path cost the same
// bcrypt work as the success path, so response time is not an existence oracle
// (F9). The value it hashes is irrelevant; it never matches a real password.
const DUMMY_PASSWORD_HASH =
  '$2b$12$7G6alC67tD4qxFFgLjE7X.MloiHqqKN47Cf7pWrq5kZHzXQ.Xz9zm';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersRepository: UsersRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: IPasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokenService: ITokenService,
  ) {}

  async login(
    username: string,
    password: string,
    meta: RequestMeta,
  ): Promise<AuthTokens & { user: PublicUser }> {
    const user = await this.usersRepository.findByUsername(username);

    if (!user || user.deleted_at) {
      // Pay the bcrypt cost even for an unknown user so timing cannot tell the
      // attacker the username exists (F9).
      await this.passwordHasher.verify(password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const isLocked =
      user.locked_until !== null && user.locked_until > new Date();

    const passwordValid = await this.passwordHasher.verify(
      password,
      user.password_hash,
    );

    // A locked account returns the same generic 401 as a wrong password rather
    // than a distinguishing 403, so lockout status is not an enumeration oracle
    // (F9). A wrong password against a locked account still counts, so the lock
    // is not a window in which brute force is free.
    if (isLocked) {
      if (!passwordValid) {
        await this.registerFailedLogin(user.id, user.failed_logins);
      }
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!passwordValid) {
      await this.registerFailedLogin(user.id, user.failed_logins);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Reachable only after a correct password, so this is not a guessing oracle
    // — it keeps its own message to explain a deliberate administrative state.
    if (!user.is_active) {
      throw new ForbiddenException('Account is inactive');
    }

    await this.prisma.users.update({
      where: { id: user.id },
      data: { failed_logins: 0, locked_until: null, last_login_at: new Date() },
    });

    const tokens = await this.issueTokens(user, randomUUID(), meta);

    return { ...tokens, user: toPublicUser(user) };
  }

  async refresh(rawToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const tokenHash = this.tokenService.hashRefreshToken(rawToken);
    const record = await this.prisma.refresh_tokens.findUnique({
      where: { token_hash: tokenHash },
    });

    if (!record || record.revoked_at) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.consumed_at) {
      // Reuse of an already-consumed token means the token was stolen: revoke
      // the whole family so both the legitimate holder and the thief are
      // logged out, per the spec's stolen-token-detection requirement.
      await this.prisma.refresh_tokens.updateMany({
        where: { family_id: record.family_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (record.expires_at < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.usersRepository.findById(record.user_id);
    if (!user || user.deleted_at || !user.is_active) {
      throw new UnauthorizedException('Account no longer active');
    }

    await this.prisma.refresh_tokens.update({
      where: { id: record.id },
      data: { consumed_at: new Date() },
    });

    return this.issueTokens(user, record.family_id, meta);
  }

  async logout(rawToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(rawToken);
    await this.prisma.refresh_tokens.updateMany({
      where: { token_hash: tokenHash, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  private async registerFailedLogin(
    userId: string,
    currentFailedLogins: number,
  ): Promise<void> {
    const failedLogins = currentFailedLogins + 1;
    const data: { failed_logins: number; locked_until?: Date } = {
      failed_logins: failedLogins,
    };
    if (failedLogins >= MAX_FAILED_LOGINS) {
      data.locked_until = new Date(Date.now() + LOCKOUT_DURATION_MS);
    }
    await this.prisma.users.update({ where: { id: userId }, data });
  }

  private async issueTokens(
    user: UserRecord,
    familyId: string,
    meta: RequestMeta,
  ): Promise<AuthTokens> {
    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      role: user.role,
      branchId: user.branch_id,
    });
    const { token: refreshToken, tokenHash } =
      this.tokenService.generateRefreshToken();

    await this.prisma.refresh_tokens.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        family_id: familyId,
        expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        ip_address: meta.ipAddress,
        user_agent: meta.userAgent,
      },
    });

    return { accessToken, refreshToken };
  }
}
