import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

// `user` is optional because public routes (login, refresh, health) never run
// the authentication guard, so nothing is attached there.
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
