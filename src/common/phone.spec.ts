import { PhoneSchema } from './phone';

describe('PhoneSchema', () => {
  // Egyptian teachers type the local form; WhatsApp needs E.164 (spec §6.2).
  it.each([
    ['a local mobile number', '01001234567', '+201001234567'],
    ['a number with spaces', ' 010 0123 4567 ', '+201001234567'],
    ['an already-international number', '+201001234567', '+201001234567'],
  ])('normalises %s to E.164', (_label, input, expected) => {
    expect(PhoneSchema.parse(input)).toBe(expected);
  });

  // Spec §9: reject, never silently coerce — a "fixed" number means a student
  // stops getting reminders and nobody notices for a month.
  it.each([
    ['too short', '0100'],
    ['letters', 'not-a-number'],
    ['empty', ''],
    ['a landline-length digit string that is not a valid number', '0000000000'],
  ])('rejects %s rather than guessing', (_label, input) => {
    expect(() => PhoneSchema.parse(input)).toThrow();
  });
});
