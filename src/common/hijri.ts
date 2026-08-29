import umalqura from '@umalqura/core';

/**
 * Hijri ↔ Gregorian conversion for *suggesting* calendar dates.
 *
 * Spec §7.5: `@umalqura/core` implements the **Saudi** Umm al-Qura calendar.
 * Egyptian institutions often follow the Survey Authority's calculation or
 * local sighting, which differ by a day often enough to matter. Gregorian is
 * stored truth; every date produced here is a default the head teacher can
 * overwrite, never a value the system schedules against on its own.
 */

export interface HijriDate {
  year: number;
  month: number; // 1 = Muharram ... 8 = Sha'ban, 9 = Ramadan, 10 = Shawwal
  day: number;
}

/**
 * Returns a UTC-midnight Date, which is what a Postgres `DATE` column needs.
 *
 * `@umalqura/core` builds its `.date` at *local* midnight, so in any timezone
 * east of UTC that instant is the previous calendar day in UTC — handing it
 * straight to Prisma stores the date one day early. Verified locally: in
 * UTC+3, `umalqura(1447, 10, 15).date` is `2026-04-02T22:00:00Z`, which a
 * `DATE` column truncates to 2026-04-02 rather than the intended 2026-04-03.
 */
export function hijriToUtcDate(hijri: HijriDate): Date {
  const local = umalqura(hijri.year, hijri.month, hijri.day).date;
  return new Date(
    Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()),
  );
}

export function toHijri(date: Date): HijriDate {
  // Read the UTC calendar day back at local noon so the library's own
  // local-midnight convention cannot round it to the neighbouring day.
  const local = new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    12,
  );
  const converted = umalqura(local);
  return { year: converted.hy, month: converted.hm, day: converted.hd };
}

export function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function midpointUtc(from: Date, to: Date): Date {
  const midpoint = new Date((from.getTime() + to.getTime()) / 2);
  return new Date(
    Date.UTC(
      midpoint.getUTCFullYear(),
      midpoint.getUTCMonth(),
      midpoint.getUTCDate(),
    ),
  );
}
