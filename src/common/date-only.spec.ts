import { DateOnlySchema, toDateOnlyString } from './date-only.schema';

describe('DateOnlySchema', () => {
  it('parses a calendar day to exact UTC midnight', () => {
    const parsed = DateOnlySchema.parse('2026-04-03');

    expect(parsed.toISOString()).toBe('2026-04-03T00:00:00.000Z');
  });

  // JS Date silently rolls impossible days forward (Feb 31 becomes Mar 3),
  // which would store a date the user never typed.
  it.each([
    ['a day that does not exist in that month', '2026-02-31'],
    ['month zero', '2026-00-10'],
    ['month thirteen', '2026-13-10'],
    ['day zero', '2026-04-00'],
  ])('rejects %s instead of rolling it forward', (_label, input) => {
    expect(() => DateOnlySchema.parse(input)).toThrow();
  });

  it.each([
    ['a timestamp', '2026-04-03T00:00:00Z'],
    ['a zoned timestamp', '2026-04-03T00:00:00+03:00'],
    ['a slash-separated date', '2026/04/03'],
    ['a two-digit year', '26-04-03'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => DateOnlySchema.parse(input)).toThrow();
  });

  it('accepts a leap day in a leap year', () => {
    expect(toDateOnlyString(DateOnlySchema.parse('2028-02-29'))).toBe(
      '2028-02-29',
    );
  });

  it('rejects a leap day in a non-leap year', () => {
    expect(() => DateOnlySchema.parse('2026-02-29')).toThrow();
  });
});
