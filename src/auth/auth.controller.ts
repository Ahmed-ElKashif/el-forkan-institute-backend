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
import { Public } from './decorators/public.decorator';
import { generateCsrfToken } from './csrf';
import { LoginDto } from './dto/login.schema';
import { LoginThrottlerGuard } from './guards/login-throttler.guard';

const REFRESH_COOKIE_NAME = 'refresh_token';
const REFRESH_COOKIE_PATH = '/auth/refresh';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto.username, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
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
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_MS,
    });
  }
}
