import { z } from 'zod';

// Postgres DATE columns hold a calendar day with no time and no zone, so the
// wire format is a plain YYYY-MM-DD and the parsed value is UTC midnight.
// Accepting a full ISO timestamp here would let a client in Cairo send
// 2026-04-03T00:00+03:00 and have it stored as 2026-04-02.
export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  .transform((value, ctx) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Not a real calendar date' });
      return z.NEVER;
    }
    // new Date('2026-02-31T00:00:00Z') rolls forward to March 3 rather than
    // failing, so compare the round-trip to catch impossible days.
    if (parsed.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: 'custom', message: 'Not a real calendar date' });
      return z.NEVER;
    }
    return parsed;
  });

export function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
