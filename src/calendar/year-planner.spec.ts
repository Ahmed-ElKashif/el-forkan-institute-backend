import { planAcademicYear, YearShapeSettings } from './year-planner';

// The defaults seeded into institute_settings by schema-v1.1.sql: the year
// runs 15 Shawwal → 15 Sha'ban (R6).
const INSTITUTE_DEFAULTS: YearShapeSettings = {
  yearStartHijriMonth: 10,
  yearStartHijriDay: 15,
  yearEndHijriMonth: 8,
  yearEndHijriDay: 15,
};

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe('planAcademicYear', () => {
  it('spans 15 Shawwal to 15 Sha‘ban of the following Hijri year', () => {
    const year = planAcademicYear(1447, INSTITUTE_DEFAULTS);

    expect(iso(year.startsOn)).toBe('2026-04-03');
    expect(iso(year.endsOn)).toBe('2027-01-23');
  });

  // The Sha'ban-precedes-Shawwal wrap is the one place this can silently
  // invert and produce a year that ends before it begins.
  it('never produces a year that ends before it starts', () => {
    for (const hijriYear of [1445, 1446, 1447, 1448, 1449]) {
      const year = planAcademicYear(hijriYear, INSTITUTE_DEFAULTS);

      expect(year.endsOn.getTime()).toBeGreaterThan(year.startsOn.getTime());
    }
  });

  it('keeps the end inside the same Hijri year when the window does not wrap', () => {
    const year = planAcademicYear(1447, {
      yearStartHijriMonth: 1,
      yearStartHijriDay: 1,
      yearEndHijriMonth: 6,
      yearEndHijriDay: 30,
    });

    expect(year.endsOn.getTime()).toBeGreaterThan(year.startsOn.getTime());
    // Six Hijri months is roughly 177 days; a wrap would make this ~354.
    const spanDays =
      (year.endsOn.getTime() - year.startsOn.getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(150);
    expect(spanDays).toBeLessThan(200);
  });

  it('produces exactly the two terms R6 requires', () => {
    const year = planAcademicYear(1447, INSTITUTE_DEFAULTS);

    expect(year.terms.map((term) => term.termNumber)).toEqual([1, 2]);
  });

  it('leaves no gap and no overlap between the terms and the year', () => {
    const [first, second] = planAcademicYear(1447, INSTITUTE_DEFAULTS).terms;

    expect(iso(first.startsOn)).toBe('2026-04-03');
    expect(iso(second.endsOn)).toBe('2027-01-23');
    // Term 2 begins the day after term 1 ends.
    const gapDays =
      (second.startsOn.getTime() - first.endsOn.getTime()) / 86_400_000;
    expect(gapDays).toBe(1);
  });

  it('puts each exam window at the end of its own term', () => {
    for (const term of planAcademicYear(1447, INSTITUTE_DEFAULTS).terms) {
      expect(term.examEndsOn.getTime()).toBe(term.endsOn.getTime());
      expect(term.examStartsOn.getTime()).toBeGreaterThan(
        term.startsOn.getTime(),
      );
      expect(term.examStartsOn.getTime()).toBeLessThan(term.endsOn.getTime());
    }
  });

  // Every generated date lands in a Postgres DATE column.
  it('emits only UTC-midnight dates', () => {
    const year = planAcademicYear(1447, INSTITUTE_DEFAULTS);
    const everyDate = [
      year.startsOn,
      year.endsOn,
      ...year.terms.flatMap((term) => [
        term.startsOn,
        term.endsOn,
        term.examStartsOn,
        term.examEndsOn,
      ]),
    ];

    for (const date of everyDate) {
      expect(date.getTime() % 86_400_000).toBe(0);
    }
  });
});
