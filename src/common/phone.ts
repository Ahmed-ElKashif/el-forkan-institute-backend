import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { z } from 'zod';
import { normalizeArabic } from './arabic';

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

/* ---------------------------------------------------------------------------
   Phones off a spreadsheet.

   `PhoneSchema` above governs what a person types into the app, and it refuses
   anything questionable on purpose. A bulk import is the opposite situation:
   the numbers were typed by many hands into Excel over years, and the roster is
   a back-fill of data the institute already has. Rejecting there does not
   protect anyone — it just silently leaves the column empty.

   So this reads generously and *normalises* to the one E.164 form the rest of
   the system stores. It never invents digits: everything below is a different
   way of writing the same number, and the result still has to satisfy
   libphonenumber before it is accepted.

   The shapes the institute's sheets actually contain:

     01012345678       the national form
     1012345678        Excel ate the leading zero by storing the cell as a NUMBER
     ٠١٠١٢٣٤٥٦٧٨        Arabic-Indic digits
     '+201012345678    the apostrophe our own export writes as Excel's
                       literal-text marker (see guardExportedCell)
     +20 101 234 5678  spaces, dashes, brackets, non-breaking spaces
     00201012345678    international prefix written out
     0201012345678     trunk zero left in front of the country code
--------------------------------------------------------------------------- */

const EGYPT_COUNTRY_CODE = '20';

/**
 * Every plausible reading of one written number, most specific first.
 *
 * Trying candidates rather than rewriting in place is what keeps a non-Egyptian
 * number working: the untouched original is tried first, so a valid +966 number
 * is returned as itself instead of being mangled into an Egyptian one.
 */
function candidates(raw: string): string[] {
  // normalizeArabic folds ٠-٩ and ۰-۹ to ASCII and strips bidi/zero-width marks,
  // which is exactly the cleanup a phone column needs too.
  const cleaned = normalizeArabic(raw).replace(/^'/, '');
  const hasPlus = cleaned.trimStart().startsWith('+');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 0) {
    return [];
  }

  const options = [hasPlus ? `+${digits}` : cleaned];

  // 00 is the international prefix; what follows is already country-coded.
  if (digits.startsWith('00')) {
    options.push(`+${digits.slice(2)}`);
  }
  if (digits.startsWith(EGYPT_COUNTRY_CODE)) {
    options.push(`+${digits}`);
  }
  // A trunk zero in front of the country code (0 20 1…) is a common slip.
  if (digits.startsWith(`0${EGYPT_COUNTRY_CODE}`)) {
    options.push(`+${digits.slice(1)}`);
  }

  // Whatever is left once trunk zeros are gone is the national number. This is
  // the branch that rescues the Excel-stripped leading zero.
  const national = digits.replace(/^0+/, '');
  if (national.length > 0) {
    options.push(`+${EGYPT_COUNTRY_CODE}${national}`);
    options.push(national);
  }

  return options;
}

/**
 * The number as E.164, or null when no reading of it is a real number.
 *
 * Null rather than a thrown error: §6.2 — "the roster is names-first", and
 * losing a whole student over a malformed phone would block the back-fill the
 * import exists to do.
 */
export function normalizeImportedPhone(raw: string): string | null {
  if (raw.trim().length === 0) {
    return null;
  }

  for (const candidate of candidates(raw)) {
    try {
      const parsed = parsePhoneNumberWithError(candidate, DEFAULT_REGION);
      if (parsed.isValid()) {
        return parsed.number;
      }
    } catch {
      // Not a readable number in this form; try the next reading.
    }
  }
  return null;
}
