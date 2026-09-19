import { addDaysUtc, hijriToUtcDate, midpointUtc, toHijri } from './hijri';

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe('hijriToUtcDate', () => {
  // The converter deals in plain {year, month, day} records, so the only place
  // a Date is built is here — in UTC. Asserting the UTC calendar day is what
  // keeps that true: a local-midnight Date would pass in UTC and fail in Cairo,
  // where the instant belongs to the previous UTC day and a Postgres DATE
  // column would store it a day early.
  it('lands on the intended UTC calendar day, not the previous one', () => {
    expect(iso(hijriToUtcDate({ year: 1447, month: 10, day: 15 }))).toBe(
      '2026-04-03',
    );
  });

  it('produces exact UTC midnight so a DATE column cannot truncate downward', () => {
    const date = hijriToUtcDate({ year: 1447, month: 10, day: 15 });

    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCMinutes()).toBe(0);
    expect(date.getUTCMilliseconds()).toBe(0);
  });

  // R6: the academic year runs ~15 Shawwal to ~15 Sha'ban, and Sha'ban (8)
  // precedes Shawwal (10) in the Hijri year, so the end date falls in the
  // FOLLOWING Hijri year. Getting this backwards would produce a year that
  // ends before it starts.
  it('places 15 Sha‘ban of the next Hijri year after 15 Shawwal of this one', () => {
    const start = hijriToUtcDate({ year: 1447, month: 10, day: 15 });
    const end = hijriToUtcDate({ year: 1448, month: 8, day: 15 });

    expect(end.getTime()).toBeGreaterThan(start.getTime());
    expect(iso(end)).toBe('2027-01-23');
  });

  // institute_settings accepts a boundary day of 1-30, but a Hijri month may
  // have only 29 days in a given year. The boundary is a recurring rule, so
  // "the 30th" has to resolve to the end of the month rather than refusing —
  // otherwise planning the same institute succeeds in one year and 500s in the
  // next. Jumada al-Thani 1447 has 29 days; Muharram 1447 has 30.
  it('clamps a 30th that does not exist to the end of that month', () => {
    expect(iso(hijriToUtcDate({ year: 1447, month: 6, day: 30 }))).toBe(
      iso(hijriToUtcDate({ year: 1447, month: 6, day: 29 })),
    );
  });

  it('leaves a 30th that does exist alone', () => {
    expect(iso(hijriToUtcDate({ year: 1447, month: 1, day: 30 }))).not.toBe(
      iso(hijriToUtcDate({ year: 1447, month: 1, day: 29 })),
    );
  });

  it('still refuses a year outside the supported range', () => {
    expect(() => hijriToUtcDate({ year: 1501, month: 8, day: 15 })).toThrow();
  });
});

describe('toHijri', () => {
  it('round-trips a Hijri date through Gregorian and back', () => {
    const original = { year: 1447, month: 10, day: 15 };

    expect(toHijri(hijriToUtcDate(original))).toEqual(original);
  });

  it.each([
    [{ year: 1447, month: 1, day: 1 }],
    [{ year: 1447, month: 9, day: 30 }],
    [{ year: 1448, month: 12, day: 29 }],
  ])('round-trips %j across month and year boundaries', (original) => {
    expect(toHijri(hijriToUtcDate(original))).toEqual(original);
  });
});

describe('addDaysUtc', () => {
  it.each([
    ['within a month', '2026-04-03', 10, '2026-04-13'],
    ['across a month boundary', '2026-04-25', 10, '2026-05-05'],
    ['across a year boundary', '2026-12-28', 10, '2027-01-07'],
    ['backwards', '2026-04-03', -3, '2026-03-31'],
  ])('adds days %s', (_label, from, days, expected) => {
    expect(iso(addDaysUtc(new Date(`${from}T00:00:00Z`), days))).toBe(expected);
  });
});

describe('midpointUtc', () => {
  it('splits an even span exactly', () => {
    expect(
      iso(
        midpointUtc(
          new Date('2026-04-01T00:00:00Z'),
          new Date('2026-04-11T00:00:00Z'),
        ),
      ),
    ).toBe('2026-04-06');
  });

  // An odd number of days lands the raw midpoint at noon; the result must
  // still be a clean UTC-midnight date for a DATE column.
  it('truncates an odd span to a whole UTC day', () => {
    const middle = midpointUtc(
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-10T00:00:00Z'),
    );

    expect(iso(middle)).toBe('2026-04-05');
    expect(middle.getUTCHours()).toBe(0);
  });
});
