import type { user_role_t } from '@prisma/client';

// What JwtAuthGuard puts on the request after verifying an access token.
// Deliberately only the JWT's own claims — anything else (full name, branch,
// section assignments) is a database lookup the guard must not do on every
// request.
//
// `role` is the Prisma enum, not a bare string: RolesGuard and the scope layer
// branch on it, and typing it here is what lets the compiler catch a comparison
// against a role that does not exist (§1.6). The value is only trusted because
// JwtAuthGuard parses the token payload through a Zod schema before it is
// assigned (F8), so a token with a malformed `role` claim is rejected at the
// guard rather than propagating an invalid enum value into authorization.
export interface AuthenticatedUser {
  id: string;
  role: user_role_t;
  branchId: number | null;
}
