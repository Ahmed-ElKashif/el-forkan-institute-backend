import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request>();
    // JwtAuthGuard runs before any handler that is not @Public() and rejects
    // the request outright when no valid token is present, so reaching this
    // line guarantees a user.
    return request.user as AuthenticatedUser;
  },
);
