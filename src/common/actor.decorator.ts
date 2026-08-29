import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

// Everything audit_logs needs about who made a request, gathered in one place.
// Passed explicitly into services that mutate data rather than read from a
// request-scoped provider: request scoping would make every consumer of an
// audited service request-scoped too, which re-instantiates the dependency
// graph on every call.
export interface Actor {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser;
    return {
      userId: user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  },
);
