import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'crypto';
import {
  AccessTokenPayload,
  ITokenService,
  RefreshTokenPair,
} from '../interfaces/token.service.interface';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class JwtTokenService implements ITokenService {
  private readonly accessSecret = process.env.JWT_ACCESS_SECRET as string;
  private readonly refreshPepper = process.env.REFRESH_TOKEN_PEPPER ?? '';

  constructor(private readonly jwt: JwtService) {}

  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwt.sign(payload, {
      secret: this.accessSecret,
      expiresIn: ACCESS_TOKEN_TTL,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, {
      secret: this.accessSecret,
    });
  }

  generateRefreshToken(): RefreshTokenPair {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    return { token, tokenHash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256')
      .update(token + this.refreshPepper)
      .digest('hex');
  }
}
