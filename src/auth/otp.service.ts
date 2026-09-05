import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PASSWORD_HASHER } from './interfaces/password-hasher.interface';
import type { IPasswordHasher } from './interfaces/password-hasher.interface';
import {
  OTP_CODE_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
} from './auth.constants';

/** Why a code was minted. A challenge verifies only against its own purpose, so
 *  a reset code (issued on email alone) can never complete a login. */
export type OtpPurpose = 'login' | 'password_reset';

export interface ChallengeMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface IssuedChallenge {
  challengeId: string;
  /** The raw code — returned once, to hand to the email sender, never stored. */
  code: string;
}

/**
 * The email-OTP second factor's whole lifecycle in one place (F12): mint a
 * code, hash it, and later verify one guess against it under a TTL and an
 * attempt cap. AuthService orchestrates; this class owns *how a code is a code*
 * — nothing else reads or writes `otp_challenges`.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: IPasswordHasher,
  ) {}

  /**
   * Issues a fresh challenge for a user whose password already checked out.
   * Any earlier unconsumed challenge is retired first, so a user has exactly
   * one live code at a time and an abandoned login cannot be completed later.
   */
  async issue(
    userId: string,
    purpose: OtpPurpose,
    meta: ChallengeMeta,
  ): Promise<IssuedChallenge> {
    const code = randomInt(0, 10 ** OTP_CODE_LENGTH)
      .toString()
      .padStart(OTP_CODE_LENGTH, '0');
    const codeHash = await this.passwordHasher.hash(code);

    // Retire only prior challenges of the same purpose: a pending login must not
    // cancel a reset the user just requested, or the reverse.
    await this.prisma.otp_challenges.updateMany({
      where: { user_id: userId, purpose, consumed_at: null },
      data: { consumed_at: new Date() },
    });

    const challenge = await this.prisma.otp_challenges.create({
      data: {
        user_id: userId,
        purpose,
        code_hash: codeHash,
        expires_at: new Date(Date.now() + OTP_TTL_MS),
        ip_address: meta.ipAddress,
        user_agent: meta.userAgent,
      },
    });
    return { challengeId: challenge.id, code };
  }

  /**
   * Verifies one guess. Returns the user id on success (consuming the
   * challenge), or null for every failure — unknown, expired, already used,
   * out of attempts, or wrong code. A wrong guess against a still-live
   * challenge costs one of its attempts.
   */
  async verify(
    challengeId: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<string | null> {
    const challenge = await this.prisma.otp_challenges.findUnique({
      where: { id: challengeId },
    });
    if (
      !challenge ||
      challenge.purpose !== purpose ||
      challenge.consumed_at !== null ||
      challenge.expires_at < new Date() ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    ) {
      return null;
    }

    const matches = await this.passwordHasher.verify(code, challenge.code_hash);
    if (!matches) {
      await this.prisma.otp_challenges.update({
        where: { id: challengeId },
        data: { attempts: { increment: 1 } },
      });
      return null;
    }

    await this.prisma.otp_challenges.update({
      where: { id: challengeId },
      data: { consumed_at: new Date() },
    });
    return challenge.user_id;
  }
}
