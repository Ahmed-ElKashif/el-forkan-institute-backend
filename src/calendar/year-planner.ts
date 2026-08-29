import { addDaysUtc, hijriToUtcDate, midpointUtc } from '../common/hijri';

/**
 * Turns a Hijri year number into the calendar the institute actually runs
 * (R6), as a set of *suggestions*.
 *
 * Pure: no database, no Nest, no clock. Everything it needs is passed in, so
 * the shape of the year can be tested without a running application — which
 * matters because getting it wrong shifts every session and exam in the year.
 */

export interface YearShapeSettings {
  yearStartHijriMonth: number;
  yearStartHijriDay: number;
  yearEndHijriMonth: number;
  yearEndHijriDay: number;
}

export interface TermShape {
  termNumber: 1 | 2;
  startsOn: Date;
  endsOn: Date;
  examStartsOn: Date;
  examEndsOn: Date;
}

export interface YearShape {
  startsOn: Date;
  endsOn: Date;
  terms: TermShape[];
}

// The last stretch of each term is its exam window; the head teacher moves it
// once the real timetable is known.
const EXAM_WINDOW_DAYS = 13;
// Term 2 starts the day after term 1 ends, so the two never overlap.
const TERM_GAP_DAYS = 1;

export function planAcademicYear(
  hijriYear: number,
  settings: YearShapeSettings,
): YearShape {
  const startsOn = hijriToUtcDate({
    year: hijriYear,
    month: settings.yearStartHijriMonth,
    day: settings.yearStartHijriDay,
  });
  const endsOn = hijriToUtcDate({
    year: endingHijriYear(hijriYear, settings),
    month: settings.yearEndHijriMonth,
    day: settings.yearEndHijriDay,
  });

  const firstTermEnd = midpointUtc(startsOn, endsOn);
  return {
    startsOn,
    endsOn,
    terms: [
      buildTerm(1, startsOn, firstTermEnd),
      buildTerm(2, addDaysUtc(firstTermEnd, TERM_GAP_DAYS), endsOn),
    ],
  };
}

/**
 * R6 runs the year from ~15 Shawwal (month 10) to ~15 Sha'ban (month 8).
 * Sha'ban *precedes* Shawwal within a Hijri year, so the end date belongs to
 * the following Hijri year — the recess between 15 Sha'ban and 15 Shawwal is
 * exactly the Ramadan/Eid break the rule describes. Comparing the two months
 * rather than hardcoding "+1" keeps this correct if the head teacher moves the
 * boundaries in institute_settings.
 */
function endingHijriYear(
  hijriYear: number,
  settings: YearShapeSettings,
): number {
  const startsLaterInYear =
    settings.yearEndHijriMonth < settings.yearStartHijriMonth ||
    (settings.yearEndHijriMonth === settings.yearStartHijriMonth &&
      settings.yearEndHijriDay <= settings.yearStartHijriDay);
  return startsLaterInYear ? hijriYear + 1 : hijriYear;
}

function buildTerm(termNumber: 1 | 2, startsOn: Date, endsOn: Date): TermShape {
  return {
    termNumber,
    startsOn,
    endsOn,
    examStartsOn: addDaysUtc(endsOn, -EXAM_WINDOW_DAYS),
    examEndsOn: endsOn,
  };
}
