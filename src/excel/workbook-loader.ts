import ExcelJS from 'exceljs';
import { cellToString } from './cell-value';

/**
 * Turns an uploaded .xlsx buffer into plain string grids.
 *
 * Spec §9, "Excel injection on import": never evaluate formulas, read cached
 * values only, cap file size and row count, parse with a timeout, merge parsed
 * rows into `Object.create(null)`. Every one of those is here or in
 * `cell-value.ts` / `sheet-reader.ts`, because this is the one code path that
 * accepts a file from a teacher's laptop.
 *
 * `xlsx` (SheetJS) is deliberately not used: the npm-published version carries
 * CVE-2023-30533, prototype pollution that triggers *when reading a crafted
 * file* — precisely this path (§7.1).
 */

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS_PER_SHEET = 5_000;
export const MAX_COLUMNS_PER_ROW = 200;
export const PARSE_TIMEOUT_MS = 30_000;

export class WorkbookTooLargeError extends Error {}
export class WorkbookParseError extends Error {}

export interface LoadedSheet {
  name: string;
  /** Row-major grid of already-stringified cells. Index 0 is worksheet row 1. */
  rows: string[][];
}

export async function loadWorkbook(
  buffer: Buffer,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<LoadedSheet[]> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  if (buffer.byteLength > maxBytes) {
    throw new WorkbookTooLargeError(
      `File is ${buffer.byteLength} bytes; the limit is ${maxBytes}`,
    );
  }

  const workbook = await withTimeout(
    // ExcelJS ships its own Buffer type declaration, unrelated to Node's.
    new ExcelJS.Workbook().xlsx.load(
      buffer as unknown as Parameters<ExcelJS.Xlsx['load']>[0],
    ),
    options.timeoutMs ?? PARSE_TIMEOUT_MS,
  );

  return workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    rows: readGrid(worksheet),
  }));
}

function readGrid(worksheet: ExcelJS.Worksheet): string[][] {
  const grid: string[][] = [];
  const rowCount = Math.min(worksheet.rowCount, MAX_ROWS_PER_SHEET);

  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const columnCount = Math.min(row.cellCount, MAX_COLUMNS_PER_ROW);
    const cells: string[] = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      cells.push(cellToString(row.getCell(columnNumber).value));
    }
    grid.push(cells);
  }

  return grid;
}

/**
 * A zip bomb or a pathological sheet can keep ExcelJS busy indefinitely. The
 * parse is not cancellable, so this bounds how long the *request* waits — the
 * abandoned parse is then garbage-collected. Bounding the file size first is
 * what keeps that abandoned work small.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new WorkbookParseError(
                `Parsing took longer than ${timeoutMs}ms and was abandoned`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
