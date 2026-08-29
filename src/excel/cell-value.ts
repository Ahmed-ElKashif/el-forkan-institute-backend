import type { CellValue } from 'exceljs';

/**
 * Reduces any ExcelJS cell to a plain string, safely.
 *
 * Spec §9: "never evaluate formulas, read cached values only". ExcelJS hands
 * back a tagged object for formulas, hyperlinks and rich text; taking
 * `.result` / `.text` rather than `.formula` is what keeps a crafted workbook
 * from turning an import into an expression evaluator. A cell whose formula
 * has no cached result reads as empty, which surfaces as a row error in the
 * preview rather than as a silent zero.
 */
export function cellToString(value: CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'object') {
    return '';
  }

  // ExcelJS types each composite cell as a closed shape with no index
  // signature, so the narrowing below has to go through `unknown`.
  const candidate = value as unknown as Record<string, unknown>;

  // Formula cell: the cached result only. `.formula` is deliberately ignored.
  if ('formula' in candidate || 'sharedFormula' in candidate) {
    return cellToString((candidate.result ?? '') as CellValue);
  }
  // Rich text: concatenate the runs, dropping the formatting.
  if (Array.isArray(candidate.richText)) {
    return candidate.richText
      .map((run) => asPlainText((run as { text?: unknown }).text))
      .join('');
  }
  // Hyperlink cell: the visible text, never the target.
  if ('text' in candidate) {
    return asPlainText(candidate.text);
  }
  // Error cell (#REF!, #DIV/0!) — no usable value.
  if ('error' in candidate) {
    return '';
  }
  return '';
}

/**
 * Stringifies only what is genuinely text. A nested object would otherwise
 * become the literal "[object Object]" and enter the database as a student's
 * name — a crafted workbook can put an object wherever ExcelJS expects a
 * string.
 */
function asPlainText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

/**
 * Spec §6.5 — CSV injection.
 *
 * A cell whose text begins with `= + - @`, tab or carriage return is executed
 * as a formula by Excel and LibreOffice when the file is opened. The victim
 * here is the head teacher opening her own roster, so the guard is applied on
 * the way *out*, to every exported cell, not only to fields that look risky.
 *
 * The leading apostrophe is Excel's own literal-text marker: it is not shown
 * in the cell and is stripped on copy.
 */
const DANGEROUS_LEADING = /^[=+\-@\t\r]/;

export function guardExportedCell(value: string): string {
  return DANGEROUS_LEADING.test(value) ? `'${value}` : value;
}
