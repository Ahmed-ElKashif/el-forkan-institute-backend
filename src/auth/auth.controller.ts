import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';
import { authCookieSecurity } from './cookie-security';
import { Public } from './decorators/public.decorator';
import { generateCsrfToken } from './csrf';
import { LoginDto } from './dto/login.schema';
import { VerifyOtpDto } from './dto/verify-otp.schema';
import { PasswordResetRequestDto } from './dto/password-reset-request.schema';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.schema';
import { LoginThrottlerGuard } from './guards/login-throttler.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // First factor: password. Returns an OTP challenge, never a session — the
  // refresh cookie is set only by verify-otp, so a stolen password alone opens
  // nothing (F12).
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.beginLogin(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // Second factor: the emailed code. This is the step that issues the session.
  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyOtp(
      dto.challengeId,
      dto.code,
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  // Forgot-password, step one: email a reset code. Throttled and keyed on
  // IP+email like login, so it cannot be used to spray addresses. Always 200
  // with a challenge id, whether or not the email exists (no enumeration).
  @Public()
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestPasswordReset(
    @Body() dto: PasswordResetRequestDto,
    @Req() req: Request,
  ) {
    return this.authService.requestPasswordReset(dto.email, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // Forgot-password, step two: a valid code sets the new password. 204 on
  // success; the user then signs in normally.
  @Public()
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
  ): Promise<void> {
    await this.authService.confirmPasswordReset(
      dto.challengeId,
      dto.code,
      dto.newPassword,
    );
  }

  // Under /auth/refresh so the refresh cookie (Path=/auth/refresh) is
  // actually present when csrf.ts binds the CSRF secret to it.
  @Public()
  @Get('refresh/csrf-token')
  getCsrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrfToken: generateCsrfToken(req, res) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!raw) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const result = await this.authService.refresh(raw, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const raw = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (raw) {
      await this.authService.logout(raw);
    }
    /* The clearing cookie must carry the same SameSite/Secure it was set with,
       or a cross-site (SameSite=None) cookie is not overwritten and logout
       leaves it in place. */
    res.clearCookie(REFRESH_COOKIE_NAME, {
      path: REFRESH_COOKIE_PATH,
      ...authCookieSecurity(),
    });
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      ...authCookieSecurity(),
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_MS,
    });
  }
}
