import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Opt-out from the globally applied JwtAuthGuard. Only three kinds of route
// qualify: login (no token exists yet), the refresh/logout pair (authenticated
// by the refresh cookie instead), and the health probe.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
