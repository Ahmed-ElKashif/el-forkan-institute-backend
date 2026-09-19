import { planAcademicYear, YearShapeSettings } from './year-planner';

/**
 * A characterisation test: it pins what `planAcademicYear` *actually* produces
 * for the years the institute is operating in, so that anything which shifts a
 * date fails loudly here rather than quietly re-planning a live year.
 *
 * It was written when the Hijri converter was swapped from `@umalqura/core` to
 * `@tabby_ai/hijri-converter`. The two agree on every day from 1402 to 1500 AH
 * (measured, not assumed), so no date below moved in that change — but the
 * next library bump, or an edit to the R6 boundaries, has nothing else
 * standing between it and every session and exam in a year.
 *
 * These are not hand-computed expectations. If one of them changes, the
 * question is "what moved and is it correct?", never "update the number".
 */

// The defaults seeded into institute_settings by schema-v1.1.sql: the year
// runs 15 Shawwal → 15 Sha'ban (R6).
const INSTITUTE_DEFAULTS: YearShapeSettings = {
  yearStartHijriMonth: 10,
  yearStartHijriDay: 15,
  yearEndHijriMonth: 8,
  yearEndHijriDay: 15,
};

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe('planAcademicYear — pinned output for the years in use', () => {
  it.each([
    [
      1445,
      '2024-04-24',
      '2025-02-14',
      '2024-09-19',
      '2024-09-20',
      '2024-09-06',
    ],
    [
      1446,
      '2025-04-13',
      '2026-02-03',
      '2025-09-08',
      '2025-09-09',
      '2025-08-26',
    ],
    [
      1447,
      '2026-04-03',
      '2027-01-23',
      '2026-08-28',
      '2026-08-29',
      '2026-08-15',
    ],
    [
      1448,
      '2027-03-23',
      '2028-01-12',
      '2027-08-17',
      '2027-08-18',
      '2027-08-04',
    ],
    [
      1449,
      '2028-03-11',
      '2028-12-31',
      '2028-08-05',
      '2028-08-06',
      '2028-07-23',
    ],
    [
      1450,
      '2029-02-28',
      '2029-12-21',
      '2029-07-26',
      '2029-07-27',
      '2029-07-13',
    ],
  ])(
    '%i starts, ends, splits and examines on exactly these days',
    (
      hijriYear,
      startsOn,
      endsOn,
      term1EndsOn,
      term2StartsOn,
      term1ExamStartsOn,
    ) => {
      const year = planAcademicYear(hijriYear, INSTITUTE_DEFAULTS);

      expect(iso(year.startsOn)).toBe(startsOn);
      expect(iso(year.endsOn)).toBe(endsOn);
      expect(iso(year.terms[0].endsOn)).toBe(term1EndsOn);
      expect(iso(year.terms[1].startsOn)).toBe(term2StartsOn);
      expect(iso(year.terms[0].examStartsOn)).toBe(term1ExamStartsOn);
    },
  );
});
