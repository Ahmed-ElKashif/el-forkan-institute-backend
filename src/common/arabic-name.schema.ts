import { z } from 'zod';

/**
 * A person's name written in Arabic letters only.
 *
 * Allowed: Arabic letters (U+0621–U+064A, which covers hamza forms, ة, ى and
 * the rest), the space between name parts, and the hyphen / apostrophe that a
 * few compound names use (e.g. «عبد-الله»). Everything else — digits (Latin or
 * Arabic-Indic), Latin letters, tatweel, punctuation — is rejected rather than
 * silently accepted, so a stray "أحمد 12" cannot enter as a name.
 *
 * Applied where a human enters a name (student create/update, an import row a
 * reviewer corrects). The bulk historical import stays deliberately lenient —
 * it is names-first and predates this rule.
 */
const ARABIC_NAME = /^[ء-ي '’-]+$/u;

export const ArabicNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(160)
  .regex(
    ARABIC_NAME,
    'Name may contain Arabic letters, spaces, hyphen or apostrophe only',
  );
