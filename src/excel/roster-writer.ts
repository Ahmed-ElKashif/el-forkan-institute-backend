import ExcelJS from 'exceljs';
import { guardExportedCell } from './cell-value';

/**
 * §6.5 — export mirrors the layout the institute already prints: two sheets
 * (إخوة / أخوات), a merged header block, data from row 6.
 *
 * Every cell goes through `guardExportedCell` (§6.5 CSV injection). The guard
 * is applied here, once, rather than at each call site: "the victim of that
 * bug is the head teacher opening her own roster", and a per-caller guard is
 * one someone eventually forgets.
 */

export const EXPORT_FIRST_DATA_ROW = 6;

export interface SheetSpec {
  /** إخوة or أخوات. */
  name: string;
  headers: string[];
  rows: string[][];
}

export interface WorkbookSpec {
  instituteName: string;
  branchName: string;
  /** Row 3 of the printed sheets: `2026 / 1447`. */
  title: string;
  sheets: SheetSpec[];
}

export async function buildRosterWorkbook(spec: WorkbookSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  for (const sheetSpec of spec.sheets) {
    const sheet = workbook.addWorksheet(sheetSpec.name, {
      // Arabic rosters read right to left; without this the printed sheet
      // comes out mirrored from the one the institute already uses.
      views: [{ rightToLeft: true }],
    });
    writeHeaderBlock(sheet, spec, sheetSpec.headers.length);
    writeHeaders(sheet, sheetSpec.headers);
    writeRows(sheet, sheetSpec.rows);
    sizeColumns(sheet, sheetSpec);
  }

  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

function writeHeaderBlock(
  sheet: ExcelJS.Worksheet,
  spec: WorkbookSpec,
  width: number,
): void {
  const lines = [spec.instituteName, spec.branchName, spec.title];
  lines.forEach((line, index) => {
    const rowNumber = index + 1;
    sheet.getCell(rowNumber, 1).value = guardExportedCell(line);
    sheet.getCell(rowNumber, 1).alignment = { horizontal: 'center' };
    sheet.getCell(rowNumber, 1).font = { bold: index === 0, size: 14 };
    if (width > 1) {
      sheet.mergeCells(rowNumber, 1, rowNumber, width);
    }
  });
}

function writeHeaders(sheet: ExcelJS.Worksheet, headers: string[]): void {
  // Row 4 holds the headers and row 5 is left blank, exactly as the institute's
  // own files are laid out (§6.1) — so an exported file can be re-imported.
  headers.forEach((header, index) => {
    const cell = sheet.getCell(4, index + 1);
    cell.value = guardExportedCell(header);
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
  });
}

function writeRows(sheet: ExcelJS.Worksheet, rows: string[][]): void {
  rows.forEach((row, rowOffset) => {
    row.forEach((value, columnOffset) => {
      const cell = sheet.getCell(
        EXPORT_FIRST_DATA_ROW + rowOffset,
        columnOffset + 1,
      );
      // Written as a string, never as a number or date: Excel would otherwise
      // reformat a phone number into scientific notation and a student code
      // into a date.
      cell.value = guardExportedCell(value);
      cell.alignment = { vertical: 'middle' };
      cell.border = {
        top: { style: 'hair' },
        left: { style: 'hair' },
        bottom: { style: 'hair' },
        right: { style: 'hair' },
      };
    });
  });
}

const MIN_COLUMN_WIDTH = 8;
const MAX_COLUMN_WIDTH = 40;

function sizeColumns(sheet: ExcelJS.Worksheet, spec: SheetSpec): void {
  spec.headers.forEach((header, index) => {
    const longestCell = spec.rows.reduce(
      (longest, row) => Math.max(longest, (row[index] ?? '').length),
      header.length,
    );
    sheet.getColumn(index + 1).width = Math.min(
      MAX_COLUMN_WIDTH,
      Math.max(MIN_COLUMN_WIDTH, longestCell + 2),
    );
  });
}
