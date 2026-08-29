import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { z } from 'zod';

const DEFAULT_REGION = 'EG';

// Spec §9: reject, never silently coerce. A number that is quietly "fixed"
// into something valid-looking means a student stops receiving the Thursday
// reminder and nobody notices for a month.
export const PhoneSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const parsed = parsePhoneNumberWithError(value, DEFAULT_REGION);
      if (!parsed.isValid()) {
        throw new Error('invalid number');
      }
      return parsed.number; // E.164, e.g. +201001234567
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Not a valid Egyptian phone number',
      });
      return z.NEVER;
    }
  });
