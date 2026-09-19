import { normalizeArabic } from '../common/arabic';

/**
 * §6.1 — the shape of the institute's real workbooks.
 *
 * Rows 1–3 carry the institute name, the branch and the title. The header is
 * merged across rows 4–5, row 5 is blank, and **data starts at row 6**.
 *
 * ⚠️ §6.2: "Column positions shift between files. L1/L3 start at column C;
 * PREP starts at column F. Map by header text, never by fixed index." That one
 * rule is why this file exists: a fixed-index parser reads the PREP file
 * silently wrong, which is worse than failing.
 */

export const FIRST_DATA_ROW = 6;
const HEADER_SEARCH_ROWS = 5;

/** Sheet name → gender (§6.2). The real files sometimes have a trailing space. */
const GENDER_BY_SHEET = new Map<string, 'male' | 'female'>([
  [normalizeArabic('إخوة'), 'male'],
  [normalizeArabic('أخوات'), 'female'],
]);

export function genderForSheetName(
  sheetName: string,
): 'male' | 'female' | null {
  return GENDER_BY_SHEET.get(normalizeArabic(sheetName)) ?? null;
}

export interface HeaderMatcher {
  /** The key this column will be exposed under. */
  key: string;
  /** Any of these header texts identifies the column, compared after Arabic
   * normalisation, so `الأسم` and `الاسم` both match. */
  aliases: string[];
  /** Header texts whose *start* identifies the column, for headers that embed a
   * level name that changes per file — `الإنتقال الى المستوى الثانى/الثالث/…`,
   * `إجتاز بمواد من المستوى الأول/الثانى/…`. Compared after normalisation, and
   * only when no alias matched exactly. */
  prefixes?: string[];
  /** When true, a missing column makes the whole sheet unreadable. */
  required?: boolean;
  /**
   * When true, EVERY column whose header matches is collected, not just the
   * first.
   *
   * §6.1: carries from earlier levels each get their own «مواد من المستوى …»
   * column, and a roster exported for several levels at once carries one per
   * level. Taking only the first would silently drop the rest — understating
   * what a student still owes, which is worse than failing.
   */
  multiple?: boolean;
}

/** Column indices per key, in sheet order. Single-column keys hold one entry. */
export type ColumnMap = Map<string, number[]>;

export class SheetLayoutError extends Error {}

/**
 * Finds each requested column by its header text, scanning the first few rows
 * because the header is merged across rows 4–5 and ExcelJS reports the text
 * only on the anchor cell of a merge.
 */
export function mapColumns(
  rows: string[][],
  matchers: HeaderMatcher[],
): ColumnMap {
  const found: ColumnMap = new Map();
  const aliasIndex = new Map<string, string>();
  const prefixIndex: Array<{ prefix: string; key: string }> = [];
  for (const matcher of matchers) {
    for (const alias of matcher.aliases) {
      aliasIndex.set(normalizeArabic(alias), matcher.key);
    }
    for (const prefix of matcher.prefixes ?? []) {
      prefixIndex.push({ prefix: normalizeArabic(prefix), key: matcher.key });
    }
  }

  const multiple = new Set(
    matchers
      .filter((matcher) => matcher.multiple)
      .map((matcher) => matcher.key),
  );

  const searchRows = rows.slice(0, HEADER_SEARCH_ROWS);
  for (const row of searchRows) {
    row.forEach((cell, columnIndex) => {
      const normalized = normalizeArabic(cell);
      if (normalized.length === 0) return;
      // Exact alias wins; a prefix only applies when no alias matched, so a
      // constant header (مواد إعادة المستوى) is never captured by another
      // column's level-prefixed header.
      const key =
        aliasIndex.get(normalized) ??
        prefixIndex.find((entry) => normalized.startsWith(entry.prefix))?.key;
      if (key === undefined) return;

      const claimed = found.get(key);
      if (claimed === undefined) {
        found.set(key, [columnIndex]);
        return;
      }
      // First match wins per COLUMN, not per key: the header is merged across
      // rows 4-5, so the same column is seen twice and must not be counted
      // twice. A `multiple` key still accepts a *different* column.
      if (multiple.has(key) && !claimed.includes(columnIndex)) {
        claimed.push(columnIndex);
      }
    });
  }

  const missing = matchers
    .filter((matcher) => matcher.required && !found.has(matcher.key))
    .map(
      (matcher) => matcher.aliases[0] ?? matcher.prefixes?.[0] ?? matcher.key,
    );
  if (missing.length > 0) {
    throw new SheetLayoutError(
      `Sheet is missing required column(s): ${missing.join(', ')}`,
    );
  }
  return found;
}

/**
 * The numbered session columns 1…15 of the printed attendance grid (§6.1).
 * They are found by their header being a bare number, so a file with 12
 * sessions or 20 works without a code change.
 */
export function mapSessionColumns(rows: string[][]): Map<number, number> {
  const sessions = new Map<number, number>();
  for (const row of rows.slice(0, HEADER_SEARCH_ROWS)) {
    row.forEach((cell, columnIndex) => {
      // normalizeArabic folds ٠-٩ to 0-9, so a sheet numbered in either script
      // maps identically.
      const text = normalizeArabic(cell);
      if (/^\d{1,2}$/.test(text)) {
        const sessionNo = Number.parseInt(text, 10);
        if (sessionNo >= 1 && sessionNo <= 30 && !sessions.has(sessionNo)) {
          sessions.set(sessionNo, columnIndex);
        }
      }
    });
  }
  return sessions;
}

export interface DataRow {
  /** 1-based worksheet row number, for reporting errors against the file. */
  rowNumber: number;
  values: Record<string, string>;
  /** Every cell of the row, so session columns can be read positionally after
   * their headers have been located by text. */
  raw: string[];
}

export function readDataRows(
  rows: string[][],
  columns: ColumnMap,
  firstDataRow = FIRST_DATA_ROW,
): DataRow[] {
  const dataRows: DataRow[] = [];

  for (let index = firstDataRow - 1; index < rows.length; index += 1) {
    const raw = rows[index] ?? [];
    const values: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [key, columnIndices] of columns) {
      // Several columns under one key are joined with the separator the subject
      // splitter already understands, so a merged cell parses exactly as a
      // single column listing the same subjects would.
      values[key] = columnIndices
        .map((columnIndex) => (raw[columnIndex] ?? '').trim())
        .filter((cell) => cell.length > 0)
        .join(' / ');
    }
    // A row where every mapped column is blank is spacing or a footer, not a
    // student. Keeping it would produce an error row per blank line.
    if (Object.values(values).some((value) => value.length > 0)) {
      dataRows.push({ rowNumber: index + 1, values, raw });
    }
  }

  return dataRows;
}
