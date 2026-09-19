"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const arabic_1 = require("../src/common/arabic");
const result_parsing_1 = require("../src/excel/result-parsing");
const sheet_reader_1 = require("../src/excel/sheet-reader");
const workbook_loader_1 = require("../src/excel/workbook-loader");
const import_parsing_1 = require("../src/import/import-parsing");
const import_service_1 = require("../src/import/import.service");
const subjects_catalogue_1 = require("../prisma/subjects.catalogue");
const DEFAULT_DIR = (0, node_path_1.join)(__dirname, '..', '..', 'sample');
function aliasMap() {
    const aliases = new Map();
    subjects_catalogue_1.SUBJECTS.forEach((subject, index) => {
        const id = index + 1;
        for (const alias of subject.aliases)
            aliases.set((0, arabic_1.normalizeArabic)(alias), id);
        aliases.set((0, arabic_1.normalizeArabic)(subject.nameAr), id);
        aliases.set((0, arabic_1.normalizeArabic)(subject.shortAr), id);
    });
    return aliases;
}
function isResultSheet(sheet) {
    try {
        (0, sheet_reader_1.mapColumns)(sheet.rows, import_service_1.RESULT_COLUMNS);
        return true;
    }
    catch {
        return false;
    }
}
function columnLetter(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}
function describeColumns(columns) {
    return [...columns]
        .map(([key, indices]) => `${key}=${indices.map(columnLetter).join('+')}`)
        .join('  ');
}
function unmappedColumns(sheet, columns) {
    const claimed = new Set([...columns.values()].flat());
    const headerRows = sheet.rows.slice(0, 5);
    const out = [];
    for (const row of headerRows) {
        row.forEach((cell, index) => {
            const text = cell.trim();
            if (text.length === 0 || claimed.has(index))
                return;
            const hasData = sheet.rows
                .slice(5)
                .some((dataRow) => (dataRow[index] ?? '').trim().length > 0);
            const label = `${columnLetter(index)} «${text}»`;
            if (hasData && !out.includes(label))
                out.push(label);
        });
    }
    return out;
}
function emptyCounts() {
    return { create: 0, update: 0, skip: 0, error: 0 };
}
async function checkFile(path, students, aliases, pass) {
    const sheets = await (0, workbook_loader_1.loadWorkbook)((0, node_fs_1.readFileSync)(path));
    const reports = [];
    for (const sheet of sheets) {
        const kind = isResultSheet(sheet) ? 'results' : 'roster';
        if (kind !== pass)
            continue;
        const report = {
            file: (0, node_path_1.basename)(path),
            sheet: sheet.name,
            gender: (0, sheet_reader_1.genderForSheetName)(sheet.name),
            kind,
            counts: emptyCounts(),
            errors: [],
            unresolved: [],
            unmapped: [],
            layoutError: null,
            hijriYear: (0, result_parsing_1.parseHijriYear)(sheet.rows.slice(0, 3).flat().join(' ')),
        };
        if (report.gender === null) {
            report.layoutError =
                'Sheet name is neither إخوة nor أخوات; the importer skips it';
            reports.push(report);
            continue;
        }
        let columns;
        try {
            columns = (0, sheet_reader_1.mapColumns)(sheet.rows, kind === 'roster' ? import_service_1.ROSTER_COLUMNS : import_service_1.RESULT_COLUMNS);
        }
        catch (error) {
            report.layoutError =
                error instanceof sheet_reader_1.SheetLayoutError ? error.message : String(error);
            reports.push(report);
            continue;
        }
        report.unmapped = unmappedColumns(sheet, columns);
        console.log(`    columns: ${describeColumns(columns)}`);
        for (const row of (0, sheet_reader_1.readDataRows)(sheet.rows, columns)) {
            if (kind === 'roster') {
                const parsed = (0, import_parsing_1.parseRosterRow)(row, students);
                report.counts[parsed.action] += 1;
                if (parsed.error)
                    report.errors.push({ row: row.rowNumber, message: parsed.error });
                if (parsed.action === 'create') {
                    students.set(parsed.parsed.normalizedName, {
                        id: `pending-${students.size + 1}`,
                        normalizedName: parsed.parsed.normalizedName,
                        hasPhone: parsed.parsed.rawPhone.length > 0,
                        hasMarkaz: parsed.parsed.rawMarkaz.length > 0,
                    });
                }
            }
            else {
                const parsed = (0, import_parsing_1.parseResultRow)(row, students, aliases);
                report.counts[parsed.action] += 1;
                if (parsed.error)
                    report.errors.push({ row: row.rowNumber, message: parsed.error });
                for (const token of parsed.parsed.unresolvedTokens) {
                    if (!report.unresolved.includes(token))
                        report.unresolved.push(token);
                }
            }
        }
        reports.push(report);
    }
    return reports;
}
function print(report) {
    const gender = report.gender ?? '—';
    console.log(`\n  ${report.kind.toUpperCase()}  «${report.sheet}»  (${gender})`);
    if (report.hijriYear)
        console.log(`    header year: ${report.hijriYear} هـ`);
    else
        console.log('    header year: none found — the year check is skipped for this sheet');
    if (report.layoutError) {
        console.log(`    ✗ LAYOUT: ${report.layoutError}`);
        return;
    }
    const { create, update, skip, error } = report.counts;
    console.log(`    rows: create=${create} update=${update} skip=${skip} error=${error}`);
    if (report.unmapped.length > 0) {
        console.log(`    ! columns with data that the import DROPS: ${report.unmapped.join(', ')}`);
    }
    if (report.unresolved.length > 0) {
        console.log(`    ! subject tokens no alias resolves: ${report.unresolved.join(', ')}`);
    }
    for (const failure of report.errors.slice(0, 10)) {
        console.log(`    ✗ row ${failure.row}: ${failure.message}`);
    }
    if (report.errors.length > 10) {
        console.log(`    … and ${report.errors.length - 10} more error rows`);
    }
}
async function main() {
    const target = process.argv[2] ?? DEFAULT_DIR;
    const files = (0, node_fs_1.statSync)(target).isDirectory()
        ? (0, node_fs_1.readdirSync)(target)
            .filter((name) => (0, node_path_1.extname)(name).toLowerCase() === '.xlsx' && !name.startsWith('~$'))
            .map((name) => (0, node_path_1.join)(target, name))
        : [target];
    if (files.length === 0) {
        console.error(`No .xlsx files in ${target}`);
        process.exitCode = 1;
        return;
    }
    const students = new Map();
    const aliases = aliasMap();
    const all = [];
    console.log(`Checking ${files.length} workbook(s) in ${target}`);
    console.log(`Alias map: ${aliases.size} spellings across ${subjects_catalogue_1.SUBJECTS.length} subjects\n`);
    for (const pass of ['roster', 'results']) {
        for (const file of files) {
            const reports = await checkFile(file, students, aliases, pass);
            if (reports.length === 0)
                continue;
            console.log(`\n=== ${(0, node_path_1.basename)(file)}`);
            reports.forEach(print);
            all.push(...reports);
        }
    }
    const totals = all.reduce((acc, report) => {
        Object.keys(acc).forEach((key) => {
            acc[key] += report.counts[key];
        });
        return acc;
    }, emptyCounts());
    const layoutFailures = all.filter((report) => report.layoutError !== null);
    const unresolved = [...new Set(all.flatMap((report) => report.unresolved))];
    console.log('\n---------------------------------------------');
    console.log(`sheets: ${all.length}   layout failures: ${layoutFailures.length}`);
    console.log(`rows:   create=${totals.create} update=${totals.update} skip=${totals.skip} error=${totals.error}`);
    if (unresolved.length > 0) {
        console.log(`\nAliases to add before importing (${unresolved.length}):`);
        console.log(`  ${unresolved.join(', ')}`);
    }
    console.log('\nNothing was written. This is what `POST /imports` would preview.');
    if (layoutFailures.length > 0)
        process.exitCode = 1;
}
void main();
//# sourceMappingURL=check-sample-imports.js.map