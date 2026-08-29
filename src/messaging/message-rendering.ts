/**
 * §7.8 / §9 — rendering a message template for one student.
 *
 * Pure, and separate from the send path, because two things here are easy to
 * get wrong and impossible to fix after the fact: what gets interpolated, and
 * what gets escaped. `messages.rendered_body` is stored as evidence of what
 * was actually sent, so whatever this returns is the record.
 */

/** `{{name}}` — double braces, matching the seeded templates in the DDL. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Written as a code-point predicate rather than a regex character class:
 * the class would have to contain literal NUL and DEL bytes in the source
 * file, which no reviewer can see and any editor may mangle.
 */
function isUnsafeCodePoint(code: number): boolean {
  return (
    code <= 0x1f || // C0 controls
    code === 0x7f || // DEL
    (code >= 0x202a && code <= 0x202e) || // bidi embedding / override
    (code >= 0x2066 && code <= 0x2069) // bidi isolates
  );
}

/**
 * Spec §9: "Escape student names before interpolating into WhatsApp
 * templates."
 *
 * A WhatsApp template body is not HTML, so HTML escaping would be wrong — it
 * would put `&amp;` in front of a real person's name. What actually matters is
 * that a value cannot introduce template syntax of its own or forge message
 * structure, so brace pairs and control characters come out.
 *
 * The bidi controls matter specifically here: this is a right-to-left message,
 * and an embedded override can reorder the displayed text so a student's
 * "name" reads as part of the institute's own wording.
 */
export function escapeTemplateValue(value: string): string {
  return [...value]
    .filter(
      (character) =>
        character !== '{' &&
        character !== '}' &&
        !isUnsafeCodePoint(character.codePointAt(0) as number),
    )
    .join('')
    .trim();
}

export interface RenderResult {
  body: string;
  /** Placeholders the template asked for that the caller did not supply.
   * Non-empty means the message must not be sent. */
  missing: string[];
}

/**
 * Substitutes `{{placeholders}}`. A missing variable is reported rather than
 * left in place or blanked: sending "تذكير: جدول يوم {{date}}" to a real
 * student is worse than not sending, and silently blanking it hides the bug.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): RenderResult {
  const missing: string[] = [];
  const body = template.replace(PLACEHOLDER, (match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      missing.push(name);
      return match;
    }
    return escapeTemplateValue(value);
  });
  return { body, missing: [...new Set(missing)] };
}

/**
 * §6.2 stores phones as E.164 (`+201001234567`). Meta's Cloud API wants the
 * digits without the leading `+`, so the conversion happens once, here, rather
 * than in the send loop.
 */
export function toWhatsAppRecipient(e164Phone: string): string {
  return e164Phone.replace(/^\+/, '');
}
