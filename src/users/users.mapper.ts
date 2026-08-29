import { users as UserRecord } from '@prisma/client';

export interface PublicUser {
  id: string;
  fullName: string;
  username: string;
  gender: string;
  role: string;
  branchId: number | null;
  phone: string;
  email: string | null;
  isActive: boolean;
}

// Never let password_hash, failed_logins, locked_until, or delete metadata
// leak past this boundary into an API response.
export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    fullName: user.full_name,
    username: user.username,
    gender: user.gender,
    role: user.role,
    branchId: user.branch_id,
    phone: user.phone,
    email: user.email,
    isActive: user.is_active,
  };
}
