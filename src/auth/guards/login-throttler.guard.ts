import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// IP alone is trivially bypassed (attacker just varies the username per
// request); username alone lets an attacker lock out a victim from any IP.
// Keying on both closes both gaps at once. This runs ALONGSIDE the global
// IP-only ThrottlerGuard (AppModule), not instead of it — layered limits.
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const ip: unknown = req.ip;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- req.body is untyped Express input by the base class's own signature
    const username: unknown = req.body?.username;
    const ipPart = typeof ip === 'string' ? ip : 'unknown-ip';
    const usernamePart = typeof username === 'string' ? username : 'unknown';
    return Promise.resolve(`${ipPart}:${usernamePart}`);
  }
}
