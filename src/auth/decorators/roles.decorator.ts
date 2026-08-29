import { SetMetadata } from '@nestjs/common';
import { user_role_t } from '@prisma/client';

export const ROLES_KEY = 'roles';

// Spec §3: the head teacher owns anything that destroys data, rewrites history
// or changes the rules. A route with no @Roles() is open to any authenticated
// user, which matches the table's "both roles" rows.
export const Roles = (...roles: user_role_t[]) => SetMetadata(ROLES_KEY, roles);
