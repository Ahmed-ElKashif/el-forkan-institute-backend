/* ---------------------------------------------------------------------------
   Runs the institute's real workbooks through the real import parser and
   reports what it would do with them — without a database, a server, or a
   single write.

       npm run import:check                 # the files in ../sample
       npm run import:check -- <dir|file>   # anywhere else

   Why a script and not only a spec: the useful output here is not pass/fail but
   the *listing* — which columns were recognised, which rows would be rejected
   and why, which subject tokens no alias resolves, and which non-empty columns
   nothing claimed. Those are the things a head teacher has to act on before an
   import is worth running.

   It drives the same functions `ImportService.preview` drives, and imports the
   very same column matchers (`ROSTER_COLUMNS` / `RESULT_COLUMNS`) rather than a
   copy, so this cannot quietly drift from what the server does.

   The student map is built from the ROSTER file itself, which is what lets the
   result files resolve names offline: §6.4 says the roster is imported first,
   and this mirrors that order.
--------------------------------------------------------------------------- */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { normalizeArabic } from '../src/common/arabic';
import { parseHijriYear } from '../src/excel/result-parsing';
import {
  genderForSheetName,
  mapColumns,
  readDataRows,
  SheetLayoutError,
  type ColumnMap,
} from '../src/excel/sheet-reader';
import { loadWorkbook, type LoadedSheet } from '../src/excel/workbook-loader';
import {
  parseResultRow,
  parseRosterRow,
  type ExistingStudent,
  type RowAction,
} from '../src/import/import-parsing';
import { ROSTER_COLUMNS, RESULT_COLUMNS } from '../src/import/import.service';
import { SUBJECTS } from '../prisma/subjects.catalogue';

const DEFAULT_DIR = join(__dirname, '..', '..', 'sample');

/** The alias map the importer resolves subject tokens against, built from the
 *  same list `seed-curriculum.ts` writes into `subject_aliases`. */
function aliasMap(): Map<string, number> {
  const aliases = new Map<string, number>();
  SUBJECTS.forEach((subject, index) => {
    const id = index + 1;
    for (const alias of subject.aliases)
      aliases.set(normalizeArabic(alias), id);
    aliases.set(normalizeArabic(subject.nameAr), id);
    aliases.set(normalizeArabic(subject.shortAr), id);
  });
  return aliases;
}

/** A results sheet is one whose header carries a decision column. Roster sheets
 *  do not, so the file's kind is read off its own layout rather than its name —
 *  the institute has two different files both called `كشف_أسماء.xlsx`. */
function isResultSheet(sheet: LoadedSheet): boolean {
  try {
    mapColumns(sheet.rows, RESULT_COLUMNS);
    return true;
  } catch {
    return false;
  }
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function describeColumns(columns: ColumnMap): string {
  return [...columns]
    .map(([key, indices]) => `${key}=${indices.map(columnLetter).join('+')}`)
    .join('  ');
}

/** Columns that hold data but no matcher claimed — the import will drop them.
 *  Reported because a dropped column is silent, and silence is the failure mode
 *  §6.3 exists to prevent. */
function unmappedColumns(sheet: LoadedSheet, columns: ColumnMap): string[] {
  const claimed = new Set([...columns.values()].flat());
  const headerRows = sheet.rows.slice(0, 5);
  const out: string[] = [];
  for (const row of headerRows) {
    row.forEach((cell, index) => {
      const text = cell.trim();
      if (text.length === 0 || claimed.has(index)) return;
      const hasData = sheet.rows
        .slice(5)
        .some((dataRow) => (dataRow[index] ?? '').trim().length > 0);
      const label = `${columnLetter(index)} «${text}»`;
      if (hasData && !out.includes(label)) out.push(label);
    });
  }
  return out;
}

interface SheetReport {
  file: string;
  sheet: string;
  gender: 'male' | 'female' | null;
  kind: 'roster' | 'results';
  counts: Record<RowAction, number>;
  errors: { row: number; message: string }[];
  unresolved: string[];
  unmapped: string[];
  layoutError: string | null;
  hijriYear: number | null;
}

function emptyCounts(): Record<RowAction, number> {
  return { create: 0, update: 0, skip: 0, error: 0 };
}

async function checkFile(
  path: string,
  students: Map<string, ExistingStudent>,
  aliases: Map<string, number>,
  pass: 'roster' | 'results',
): Promise<SheetReport[]> {
  const sheets = await loadWorkbook(readFileSync(path));
  const reports: SheetReport[] = [];

  for (const sheet of sheets) {
    const kind = isResultSheet(sheet) ? 'results' : 'roster';
    if (kind !== pass) continue;

    const report: SheetReport = {
      file: basename(path),
      sheet: sheet.name,
      gender: genderForSheetName(sheet.name),
      kind,
      counts: emptyCounts(),
      errors: [],
      unresolved: [],
      unmapped: [],
      layoutError: null,
      // §6.2: the year is read off the header, never trusted from the filename.
      hijriYear: parseHijriYear(sheet.rows.slice(0, 3).flat().join(' ')),
    };

    if (report.gender === null) {
      report.layoutError =
        'Sheet name is neither إخوة nor أخوات; the importer skips it';
      reports.push(report);
      continue;
    }

    let columns: ColumnMap;
    try {
      columns = mapColumns(
        sheet.rows,
        kind === 'roster' ? ROSTER_COLUMNS : RESULT_COLUMNS,
      );
    } catch (error) {
      report.layoutError =
        error instanceof SheetLayoutError ? error.message : String(error);
      reports.push(report);
      continue;
    }

    report.unmapped = unmappedColumns(sheet, columns);
    console.log(`    columns: ${describeColumns(columns)}`);

    for (const row of readDataRows(sheet.rows, columns)) {
      if (kind === 'roster') {
        const parsed = parseRosterRow(row, students);
        report.counts[parsed.action] += 1;
        if (parsed.error)
          report.errors.push({ row: row.rowNumber, message: parsed.error });
        // A created student becomes matchable, exactly as the commit would make
        // them — otherwise every result row after the first would miss.
        if (parsed.action === 'create') {
          students.set(parsed.parsed.normalizedName, {
            id: `pending-${students.size + 1}`,
            normalizedName: parsed.parsed.normalizedName,
            hasPhone: parsed.parsed.rawPhone.length > 0,
            hasMarkaz: parsed.parsed.rawMarkaz.length > 0,
          });
        }
      } else {
        const parsed = parseResultRow(row, students, aliases);
        report.counts[parsed.action] += 1;
        if (parsed.error)
          report.errors.push({ row: row.rowNumber, message: parsed.error });
        for (const token of parsed.parsed.unresolvedTokens) {
          if (!report.unresolved.includes(token)) report.unresolved.push(token);
        }
      }
    }

    reports.push(report);
  }
  return reports;
}

function print(report: SheetReport): void {
  const gender = report.gender ?? '—';
  console.log(
    `\n  ${report.kind.toUpperCase()}  «${report.sheet}»  (${gender})`,
  );
  if (report.hijriYear) console.log(`    header year: ${report.hijriYear} هـ`);
  else
    console.log(
      '    header year: none found — the year check is skipped for this sheet',
    );

  if (report.layoutError) {
    console.log(`    ✗ LAYOUT: ${report.layoutError}`);
    return;
  }

  const { create, update, skip, error } = report.counts;
  console.log(
    `    rows: create=${create} update=${update} skip=${skip} error=${error}`,
  );

  if (report.unmapped.length > 0) {
    console.log(
      `    ! columns with data that the import DROPS: ${report.unmapped.join(', ')}`,
    );
  }
  if (report.unresolved.length > 0) {
    console.log(
      `    ! subject tokens no alias resolves: ${report.unresolved.join(', ')}`,
    );
  }
  for (const failure of report.errors.slice(0, 10)) {
    console.log(`    ✗ row ${failure.row}: ${failure.message}`);
  }
  if (report.errors.length > 10) {
    console.log(`    … and ${report.errors.length - 10} more error rows`);
  }
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? DEFAULT_DIR;
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter(
          (name) =>
            extname(name).toLowerCase() === '.xlsx' && !name.startsWith('~$'),
        )
        .map((name) => join(target, name))
    : [target];

  if (files.length === 0) {
    console.error(`No .xlsx files in ${target}`);
    process.exitCode = 1;
    return;
  }

  const students = new Map<string, ExistingStudent>();
  const aliases = aliasMap();
  const all: SheetReport[] = [];

  console.log(`Checking ${files.length} workbook(s) in ${target}`);
  console.log(
    `Alias map: ${aliases.size} spellings across ${SUBJECTS.length} subjects\n`,
  );

  // Rosters first, so the names they introduce are matchable by the result
  // sheets — the order §6.4 prescribes for a real import.
  for (const pass of ['roster', 'results'] as const) {
    for (const file of files) {
      const reports = await checkFile(file, students, aliases, pass);
      if (reports.length === 0) continue;
      console.log(`\n=== ${basename(file)}`);
      reports.forEach(print);
      all.push(...reports);
    }
  }

  const totals = all.reduce((acc, report) => {
    (Object.keys(acc) as RowAction[]).forEach((key) => {
      acc[key] += report.counts[key];
    });
    return acc;
  }, emptyCounts());
  const layoutFailures = all.filter((report) => report.layoutError !== null);
  const unresolved = [...new Set(all.flatMap((report) => report.unresolved))];

  console.log('\n---------------------------------------------');
  console.log(
    `sheets: ${all.length}   layout failures: ${layoutFailures.length}`,
  );
  console.log(
    `rows:   create=${totals.create} update=${totals.update} skip=${totals.skip} error=${totals.error}`,
  );
  if (unresolved.length > 0) {
    console.log(`\nAliases to add before importing (${unresolved.length}):`);
    console.log(`  ${unresolved.join(', ')}`);
  }
  console.log(
    '\nNothing was written. This is what `POST /imports` would preview.',
  );

  // A layout failure means a sheet the importer cannot read at all, which is
  // the one outcome worth failing a pipeline over.
  if (layoutFailures.length > 0) process.exitCode = 1;
}

void main();
