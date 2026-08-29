import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TOKEN_SERVICE } from '../interfaces/token.service.interface';
import type {
  AccessTokenPayload,
  ITokenService,
} from '../interfaces/token.service.interface';

const BEARER_SCHEME = 'Bearer';

// Registered as a global APP_GUARD (AppModule): every route is authenticated
// unless it opts out with @Public(). Deny-by-default is the point — a new
// controller added later is protected without anyone remembering to protect it.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_SERVICE) private readonly tokenService: ITokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const payload = this.verifyBearerToken(request.headers.authorization);
    request.user = {
      id: payload.sub,
      role: payload.role,
      branchId: payload.branchId,
    };
    return true;
  }

  private verifyBearerToken(authorizationHeader?: string): AccessTokenPayload {
    const [scheme, token] = authorizationHeader?.split(' ') ?? [];
    if (scheme !== BEARER_SCHEME || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      return this.tokenService.verifyAccessToken(token);
    } catch {
      // jsonwebtoken distinguishes expired / malformed / bad-signature, but
      // the caller gets one answer for all three: telling an attacker which
      // of the three it was is free reconnaissance.
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
