import { gregorianToHijri, hijriToGregorian } from '@tabby_ai/hijri-converter';

/**
 * Hijri ↔ Gregorian conversion for *suggesting* calendar dates.
 *
 * Spec §7.5: the Umm al-Qura calendar is the **Saudi** reckoning. Egyptian
 * institutions often follow the Survey Authority's calculation or local
 * sighting, which differ by a day often enough to matter. Gregorian is stored
 * truth; every date produced here is a default the head teacher can overwrite,
 * never a value the system schedules against on its own.
 *
 * `@tabby_ai/hijri-converter` converts between plain `{year, month, day}`
 * records and never constructs a `Date`, so there is no local-vs-UTC midnight
 * to defend against: this module is the only place a `Date` is built, and it
 * builds it directly in UTC.
 */

export interface HijriDate {
  year: number;
  month: number; // 1 = Muharram ... 8 = Sha'ban, 9 = Ramadan, 10 = Shawwal
  day: number;
}

/**
 * Every Hijri month has 29 days; only some have a 30th.
 *
 * `institute_settings.year_start/end_hijri_day` accepts 1-30, so a head
 * teacher can legitimately anchor the year to "the 30th" of a month that has
 * 29 days in a given year. That has to mean the end of the month, not an
 * error: the boundary is a recurring rule applied to many years, and refusing
 * it would make planning fail in some years and succeed in others.
 */
const SHORTEST_HIJRI_MONTH = 29;

function clampToMonthEnd(hijri: HijriDate): HijriDate {
  if (hijri.day <= SHORTEST_HIJRI_MONTH) {
    return hijri;
  }
  try {
    hijriToGregorian(hijri);
    return hijri;
  } catch {
    return { ...hijri, day: SHORTEST_HIJRI_MONTH };
  }
}

/** Returns a UTC-midnight Date, which is what a Postgres `DATE` column needs. */
export function hijriToUtcDate(hijri: HijriDate): Date {
  const gregorian = hijriToGregorian(clampToMonthEnd(hijri));
  return new Date(Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day));
}

export function toHijri(date: Date): HijriDate {
  return gregorianToHijri({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
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
