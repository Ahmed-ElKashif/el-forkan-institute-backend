// What JwtAuthGuard puts on the request after verifying an access token.
// Deliberately only the JWT's own claims — anything else (full name, branch,
// section assignments) is a database lookup the guard must not do on every
// request.
export interface AuthenticatedUser {
  id: string;
  role: string;
  branchId: number | null;
}
