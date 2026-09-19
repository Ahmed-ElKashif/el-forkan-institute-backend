import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { resolveWritableBranch } from '../common/access-scope';
import { normalizeArabic } from '../common/arabic';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { buildPage, Page, toPrismaPage } from '../common/pagination';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { parseHijriYear } from '../excel/result-parsing';
import {
  ColumnMap,
  genderForSheetName,
  mapColumns,
  readDataRows,
  SheetLayoutError,
} from '../excel/sheet-reader';
import { loadWorkbook } from '../excel/workbook-loader';
import { PrismaService } from '../prisma/prisma.service';
import type {
  FixImportRowDto,
  ListImportRowsQueryDto,
  StartImportDto,
} from './dto/import.schema';
import {
  ExistingStudent,
  parseResultRow,
  parseRosterRow,
  RowAction,
} from './import-parsing';

/**
 * §6.3 — "upload → parse into import_rows → show create/update/skip/error per
 * row → teacher fixes → commit". Not optional polish: the real data would
 * corrupt the database on the first fire-and-forget run.
 *
 * Nothing in `preview` touches a domain table. Everything lands in
 * `import_jobs` / `import_rows`, which is what makes the review step real
 * rather than advisory.
 */

// §6.2 — matched by header TEXT, never by column index, because L1/L3 start at
// column C and PREP starts at column F.
const ROSTER_COLUMNS = [
  { key: 'serial', aliases: ['م', 'مسلسل'] },
  { key: 'name', aliases: ['الأسم', 'الاسم', 'اسم الطالب'], required: true },
  { key: 'markaz', aliases: ['المركز', 'مركز'] },
  {
    key: 'phone',
    aliases: ['رقم الهاتف', 'الهاتف', 'التليفون', 'رقم التليفون'],
  },
];

const RESULT_COLUMNS = [
  { key: 'serial', aliases: ['م', 'مسلسل'] },
  { key: 'name', aliases: ['الأسم', 'الاسم', 'اسم الطالب'], required: true },
  // The real decision header names the destination level and so changes per
  // file: «الإنتقال الى المستوى الثانى/الثالث/الرابع/التكميلى/الأول». Matched by
  // its stable prefix; the plain aliases cover any simpler sheet.
  {
    key: 'decision',
    aliases: ['النتيجة', 'النتيجه', 'القرار', 'نتيجة المستوى'],
    prefixes: ['الانتقال الى المستوى'],
    required: true,
  },
  // «إجتاز بمواد من المستوى الأول/الثانى/…» — the carried-subjects list.
  {
    key: 'carrySubjects',
    aliases: ['المواد المتبقية', 'مواد بمواد', 'إجتاز المستوى بمواد'],
    prefixes: ['اجتاز بمواد من المستوى'],
  },
  { key: 'repeatSubjects', aliases: ['مواد إعادة المستوى', 'مواد الإعادة'] },
  // L2 / L3 أخوات (§6.1) — carries that survived more than one promotion, in a
  // «مواد من المستوى الأول/الثانى» column separate from this level's carries.
  {
    key: 'priorLevelSubjects',
    aliases: [],
    prefixes: ['مواد من المستوى'],
  },
];

export interface ImportRowView {
  id: string;
  sheetName: string | null;
  rowNumber: number;
  action: string | null;
  errorMessage: string | null;
  matchStudentId: string | null;
  raw: unknown;
  parsed: unknown;
}

export interface ImportJobView {
  id: string;
  importType: string;
  status: string;
  originalFilename: string | null;
  totalRows: number | null;
  okRows: number | null;
  failedRows: number | null;
  committedAt: string | null;
  createdAt: string;
  countsByAction: Record<RowAction, number>;
}

interface SheetContext {
  sheetName: string;
  gender: 'male' | 'female';
  sectionId: string;
}

/**
 * The targeting a commit applies, read from the persisted `import_jobs` row —
 * never from the request. This is the whole point of F3b: `commit` cannot be
 * pointed at a different branch, year or historical flag than the one the
 * preview was reviewed under.
 */
interface CommitTargeting {
  branchId: number;
  academicYearId: number;
  isHistorical: boolean;
}

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Parses the upload and stores one `import_rows` row per data row, each with
   * its intended action. Returns the job so the caller can render the preview.
   */
  async preview(
    file: { buffer: Buffer; originalname: string },
    dto: StartImportDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<ImportJobView> {
    // F3: a branch-bound teacher may only import into their own branch; the
    // body's branchId is theirs by force. This resolved value is what is stored
    // on the job and what every downstream query and the commit read.
    const branchId = resolveWritableBranch(viewer, dto.branchId);
    if (branchId === null) {
      throw new BadRequestException('An import must target a branch');
    }
    const dtoWithBranch: StartImportDto = { ...dto, branchId };

    const sheets = await loadWorkbook(file.buffer);
    const contexts = this.resolveSheetContexts(sheets, dtoWithBranch);
    if (contexts.length === 0) {
      throw new BadRequestException(
        'No sheet named إخوة or أخوات was found, and no section was named for one',
      );
    }
    await this.assertYearMatchesFile(sheets, dtoWithBranch);

    const job = await this.prisma.import_jobs.create({
      data: {
        import_type: dtoWithBranch.importType,
        branch_id: branchId,
        academic_year_id: dtoWithBranch.academicYearId,
        // F3b: persist the historical flag now; commit reads it from here.
        is_historical: dtoWithBranch.isHistorical,
        // The upload is held in memory for this request only. Persisting it to
        // Supabase Storage (§7.6.4) is a separate concern from parsing it, and
        // the row keeps a name so a stored copy can be linked later.
        storage_path: `memory://${file.originalname}`,
        original_filename: file.originalname,
        status: 'running',
        created_by: actor.userId,
      },
    });

    const rows: Prisma.import_rowsCreateManyInput[] = [];
    for (const context of contexts) {
      const sheet = sheets.find(
        (candidate) => candidate.name === context.sheetName,
      );
      if (!sheet) continue;
      rows.push(
        ...(await this.parseSheet(sheet.rows, context, dtoWithBranch, job.id)),
      );
    }

    await this.prisma.import_rows.createMany({ data: rows });
    const counts = countActions(rows);
    const finished = await this.prisma.import_jobs.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        total_rows: rows.length,
        ok_rows: counts.create + counts.update + counts.skip,
        failed_rows: counts.error,
        finished_at: new Date(),
      },
    });

    await this.audit.record(actor, {
      action: 'import.preview',
      entityType: 'import_job',
      entityId: job.id,
      after: { file: file.originalname, ...counts },
    });
    return toJobView(finished, counts);
  }

  /**
   * Loads a job and refuses if the viewer's branch may not see it (F3a).
   * Every job- and row-addressed route funnels through this, so a teacher can
   * no longer read another branch's roster by guessing a job UUID.
   */
  private async loadVisibleJob(jobId: string, viewer: AuthenticatedUser) {
    const job = await this.prisma.import_jobs.findUniqueOrThrow({
      where: { id: jobId },
    });
    if (viewer.branchId !== null && job.branch_id !== viewer.branchId) {
      throw new NotFoundException('Import job not found');
    }
    return job;
  }

  async getJob(
    jobId: string,
    viewer: AuthenticatedUser,
  ): Promise<ImportJobView> {
    const job = await this.loadVisibleJob(jobId, viewer);
    return toJobView(job, await this.countActions(jobId));
  }

  async listRows(
    jobId: string,
    query: ListImportRowsQueryDto,
    viewer: AuthenticatedUser,
  ): Promise<Page<ImportRowView>> {
    await this.loadVisibleJob(jobId, viewer);
    const where: Prisma.import_rowsWhereInput = {
      import_job_id: jobId,
      ...(query.action ? { action: query.action } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.import_rows.findMany({
        where,
        orderBy: [{ sheet_name: 'asc' }, { row_number: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.import_rows.count({ where }),
    ]);
    return buildPage(rows.map(toRowView), total, query);
  }

  /** The "teacher fixes" step of §6.3, one row at a time. */
  async fixRow(
    rowId: bigint,
    dto: FixImportRowDto,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<ImportRowView> {
    const row = await this.prisma.import_rows.findUniqueOrThrow({
      where: { id: rowId },
    });
    const job = await this.loadVisibleJob(row.import_job_id, viewer);
    if (job.committed_at) {
      throw new ConflictException(
        'This import has already been committed and can no longer be edited',
      );
    }

    // F3c: `matchStudentId` becomes the update target at commit. Without this a
    // teacher could point a row at any student UUID in the institute and have
    // the commit overwrite that student's phone and markaz. Only a student in
    // this job's own branch may be named.
    if (dto.matchStudentId != null) {
      const target = await this.prisma.students.findUnique({
        where: { id: dto.matchStudentId },
        select: { branch_id: true, deleted_at: true },
      });
      if (!target || target.deleted_at || target.branch_id !== job.branch_id) {
        throw new BadRequestException(
          'The matched student is not in this import’s branch',
        );
      }
    }

    const parsed = {
      ...(row.parsed as Record<string, unknown>),
      ...(dto.fullName === undefined
        ? {}
        : {
            fullName: dto.fullName,
            normalizedName: normalizeArabic(dto.fullName),
          }),
      ...(dto.phone === undefined ? {} : { rawPhone: dto.phone ?? '' }),
      ...(dto.markazId === undefined ? {} : { markazId: dto.markazId }),
      ...(dto.subjectIds === undefined
        ? {}
        : { carrySubjectIds: dto.subjectIds, unresolvedTokens: [] }),
    };

    const updated = await this.prisma.import_rows.update({
      where: { id: rowId },
      data: {
        parsed: parsed,
        ...(dto.action ? { action: dto.action } : {}),
        ...(dto.matchStudentId === undefined
          ? {}
          : { match_student_id: dto.matchStudentId }),
        // A row the reviewer has corrected is no longer in error; leaving the
        // message would make the preview keep flagging a fixed row.
        ...(dto.action && dto.action !== 'skip' ? { error_message: null } : {}),
      },
    });

    await this.audit.record(actor, {
      action: 'import.row.fix',
      entityType: 'import_job',
      entityId: row.import_job_id,
      before: toRowView(row),
      after: toRowView(updated),
    });
    return toRowView(updated);
  }

  /**
   * Applies every non-error row in one transaction. All-or-nothing on purpose:
   * a half-applied roster is worse than none, because the reviewer cannot tell
   * which half landed.
   */
  /**
   * F3b: `commit` no longer takes a body. The branch, year and historical flag
   * are read from the `import_jobs` row the preview persisted, so a caller can
   * neither retarget the commit at another branch/year nor flip `isHistorical`
   * to make the promotion engine silently skip the imported rows. The job id is
   * all that is needed.
   */
  async commit(
    jobId: string,
    actor: Actor,
    viewer: AuthenticatedUser,
  ): Promise<ImportJobView> {
    const job = await this.loadVisibleJob(jobId, viewer);
    if (job.committed_at) {
      throw new ConflictException('This import has already been committed');
    }
    if (job.branch_id === null || job.academic_year_id === null) {
      throw new BadRequestException(
        'This import job is missing its branch or year; re-run the preview',
      );
    }
    const targeting: CommitTargeting = {
      branchId: job.branch_id,
      academicYearId: job.academic_year_id,
      isHistorical: job.is_historical,
    };

    const rows = await this.prisma.import_rows.findMany({
      where: { import_job_id: jobId, action: { in: ['create', 'update'] } },
      orderBy: [{ sheet_name: 'asc' }, { row_number: 'asc' }],
    });
    if (rows.length === 0) {
      throw new BadRequestException(
        'No rows are marked create or update; nothing would be applied',
      );
    }

    let deferredCarries = 0;
    await this.prisma.$transaction(
      async (tx) => {
        for (const row of rows) {
          if (job.import_type === 'roster') {
            await this.applyRosterRow(tx, row, targeting);
          } else {
            deferredCarries += await this.applyResultRow(tx, row, targeting);
          }
        }
        await tx.import_jobs.update({
          where: { id: jobId },
          data: { committed_at: new Date() },
        });
      },
      // A whole roster of per-row writes over the remote pooler does not fit in
      // Prisma's default 5s interactive-transaction budget. All-or-nothing is the
      // point of the transaction, so the fix is room, not splitting it.
      { timeout: 60_000, maxWait: 15_000 },
    );

    await this.audit.record(actor, {
      action: 'import.commit',
      entityType: 'import_job',
      entityId: jobId,
      after: {
        appliedRows: rows.length,
        isHistorical: targeting.isHistorical,
        // Non-zero means some carries are still waiting for next year's roster
        // to exist; re-running this import once it does will attach them.
        deferredCarries,
      },
    });
    return this.getJob(jobId, viewer);
  }

  // ---------------------------------------------------------------- parsing

  private resolveSheetContexts(
    sheets: Array<{ name: string }>,
    dto: StartImportDto,
  ): SheetContext[] {
    const sectionByGender: Record<'male' | 'female', string | undefined> = {
      male: dto.maleSectionId,
      female: dto.femaleSectionId,
    };
    const contexts: SheetContext[] = [];
    for (const sheet of sheets) {
      const gender = genderForSheetName(sheet.name);
      if (!gender) continue;
      const sectionId = sectionByGender[gender];
      // A sheet with no section named for it is skipped rather than guessed
      // at: the file may legitimately contain only one gender.
      if (!sectionId) continue;
      contexts.push({ sheetName: sheet.name, gender, sectionId });
    }
    return contexts;
  }

  /**
   * §6.2: "Header row 3 `2026 / 1447` → parse the Hijri part, don't trust the
   * filename." Importing a 1447 file into 1448 would silently attach a whole
   * year of results to the wrong cohort, so the file's own claim is checked
   * against the year the caller selected.
   */
  private async assertYearMatchesFile(
    sheets: Array<{ rows: string[][] }>,
    dto: StartImportDto,
  ): Promise<void> {
    const headerText = sheets
      .flatMap((sheet) => sheet.rows.slice(0, 3).flat())
      .join(' ');
    const fileHijriYear = parseHijriYear(headerText);
    if (fileHijriYear === null) {
      return; // The header does not state a year; nothing to contradict.
    }
    const year = await this.prisma.academic_years.findUniqueOrThrow({
      where: { id: dto.academicYearId },
      select: { hijri_year: true },
    });
    if (year.hijri_year !== fileHijriYear) {
      throw new BadRequestException(
        `This file is for ${fileHijriYear}, but ${year.hijri_year} was selected`,
      );
    }
  }

  private async parseSheet(
    rows: string[][],
    context: SheetContext,
    dto: StartImportDto,
    jobId: string,
  ): Promise<Prisma.import_rowsCreateManyInput[]> {
    const matchers =
      dto.importType === 'roster' ? ROSTER_COLUMNS : RESULT_COLUMNS;
    let columns: ColumnMap;
    try {
      columns = mapColumns(rows, matchers);
    } catch (error) {
      if (error instanceof SheetLayoutError) {
        // One unreadable sheet must not lose the other one's rows, so this is
        // recorded as a single error row rather than failing the whole upload.
        return [
          {
            import_job_id: jobId,
            sheet_name: context.sheetName,
            row_number: 0,
            raw: {},
            action: 'error',
            error_message: error.message,
          },
        ];
      }
      throw error;
    }

    const dataRows = readDataRows(rows, columns);
    const students = await this.loadExistingStudents(context, dto);
    const aliases = await this.loadSubjectAliases();

    return dataRows.map((dataRow) => {
      const result =
        dto.importType === 'roster'
          ? parseRosterRow(dataRow, students)
          : parseResultRow(dataRow, students, aliases);
      return {
        import_job_id: jobId,
        sheet_name: context.sheetName,
        row_number: dataRow.rowNumber,
        raw: dataRow.values,
        parsed: {
          ...result.parsed,
          sectionId: context.sectionId,
          gender: context.gender,
        },
        action: result.action,
        match_student_id: result.matchStudentId,
        error_message: result.error,
      };
    });
  }

  /**
   * Loads the candidate students once per sheet and matches in memory.
   *
   * The institute has ~96 students (spec §1) and a roster sheet is one
   * section, so this is a few hundred rows at worst — cheaper than a query per
   * row, and it is the only way to match on the *normalised* name, which no
   * index can answer.
   */
  private async loadExistingStudents(
    context: SheetContext,
    dto: StartImportDto,
  ): Promise<Map<string, ExistingStudent>> {
    const rows = await this.prisma.students.findMany({
      where: {
        deleted_at: null,
        gender: context.gender,
        branch_id: dto.branchId,
      },
      select: {
        id: true,
        full_name: true,
        phone: true,
        markaz_id: true,
      },
    });

    const byNormalizedName = new Map<string, ExistingStudent>();
    for (const row of rows) {
      const normalizedName = normalizeArabic(row.full_name);
      // Two students with names that normalise identically cannot be told
      // apart automatically. Keeping the first means the second's rows land as
      // "update the first", which the reviewer sees and can repoint.
      if (!byNormalizedName.has(normalizedName)) {
        byNormalizedName.set(normalizedName, {
          id: row.id,
          normalizedName,
          hasPhone: row.phone !== null,
          hasMarkaz: row.markaz_id !== null,
        });
      }
    }
    return byNormalizedName;
  }

  private async loadSubjectAliases(): Promise<Map<string, number>> {
    const aliases = await this.prisma.subject_aliases.findMany({
      select: { normalized: true, subject_id: true },
    });
    return new Map(
      aliases.map((alias) => [alias.normalized, alias.subject_id]),
    );
  }

  // --------------------------------------------------------------- applying

  private async applyRosterRow(
    tx: Prisma.TransactionClient,
    row: {
      parsed: Prisma.JsonValue;
      match_student_id: string | null;
      action: string | null;
    },
    dto: CommitTargeting,
  ): Promise<void> {
    const parsed = row.parsed as {
      fullName: string;
      rawPhone: string;
      sectionId: string;
      gender: 'male' | 'female';
      markazId?: number | null;
    };
    const phone = toE164OrNull(parsed.rawPhone);

    const studentId =
      row.action === 'create'
        ? (
            await tx.students.create({
              data: {
                full_name: parsed.fullName,
                gender: parsed.gender,
                branch_id: dto.branchId,
                phone,
                markaz_id: parsed.markazId ?? null,
              },
              select: { id: true },
            })
          ).id
        : (row.match_student_id as string);

    if (row.action === 'update') {
      await tx.students.update({
        where: { id: studentId },
        data: {
          // Only fills gaps. §6.4's flow is teachers adding what the old
          // sheets never had, not an import overwriting corrections they made.
          ...(phone ? { phone } : {}),
          ...(parsed.markazId ? { markaz_id: parsed.markazId } : {}),
          updated_at: new Date(),
        },
      });
    }

    // §6.4 step 3. `enrollments` is UNIQUE (student_id, academic_year_id), so
    // re-running the import cannot duplicate a student's year.
    const existing = await tx.enrollments.findFirst({
      where: { student_id: studentId, academic_year_id: dto.academicYearId },
      select: { id: true },
    });
    if (!existing) {
      const section = await tx.sections.findUniqueOrThrow({
        where: { id: parsed.sectionId },
        select: { academic_year_id: true, branch_id: true, gender: true },
      });
      await tx.enrollments.create({
        data: {
          student_id: studentId,
          section_id: parsed.sectionId,
          academic_year_id: section.academic_year_id,
          branch_id: section.branch_id,
          gender: section.gender,
          is_historical: dto.isHistorical,
        },
      });
    }
  }

  /** Returns how many carries could not be attached yet — see the comment
   * below on why a carry needs a forward enrolment to hang from. */
  private async applyResultRow(
    tx: Prisma.TransactionClient,
    row: { parsed: Prisma.JsonValue; match_student_id: string | null },
    dto: CommitTargeting,
  ): Promise<number> {
    const parsed = row.parsed as {
      decision: 'promote' | 'promote_with_carry' | 'repeat';
      carrySubjectIds: number[];
    };
    const enrollment = await tx.enrollments.findFirst({
      where: {
        student_id: row.match_student_id as string,
        academic_year_id: dto.academicYearId,
      },
      select: { id: true, section: { select: { level_id: true } } },
    });
    if (!enrollment) {
      throw new NotFoundException(
        'A result row refers to a student with no enrolment this year; import the roster first',
      );
    }

    await tx.enrollments.update({
      where: { id: enrollment.id },
      data: {
        final_decision: parsed.decision,
        decided_at: new Date(),
        status: 'completed',
        is_historical: dto.isHistorical,
      },
    });

    if (parsed.carrySubjectIds.length === 0) {
      return 0;
    }

    /**
     * §6.4 step 4 — carried subjects from the carry columns.
     *
     * A carry row means "this enrolment owes a subject from an earlier one":
     * `enrollment_id` is the year that carries it, `from_enrollment_id` is
     * where it was failed, and the DDL enforces the distinction with
     * `CHECK (enrollment_id <> from_enrollment_id)`. So the carry attaches to
     * the student's *next* enrolment, not to the one the result sheet
     * describes.
     *
     * Importing 1447's results before 1448's roster exists therefore leaves
     * the carry with nowhere to attach. Rather than inventing an enrolment or
     * silently dropping the debt, the row is left for the next import: the
     * parsed carry list stays on `import_rows`, and the commit reports how
     * many were deferred so the head teacher knows to re-run it once next
     * year's roster is in.
     */
    const forwardEnrollment = await tx.enrollments.findFirst({
      where: {
        student_id: row.match_student_id as string,
        academic_year_id: { gt: dto.academicYearId },
      },
      orderBy: { academic_year_id: 'asc' },
      select: { id: true },
    });
    if (!forwardEnrollment) {
      return parsed.carrySubjectIds.length;
    }

    // UNIQUE (enrollment, subject, origin_level) makes re-running idempotent.
    for (const subjectId of parsed.carrySubjectIds) {
      await tx.carried_subjects.upsert({
        where: {
          enrollment_id_subject_id_origin_level_id: {
            enrollment_id: forwardEnrollment.id,
            subject_id: subjectId,
            origin_level_id: enrollment.section.level_id,
          },
        },
        create: {
          enrollment_id: forwardEnrollment.id,
          from_enrollment_id: enrollment.id,
          subject_id: subjectId,
          origin_level_id: enrollment.section.level_id,
        },
        update: {},
      });
    }
    return 0;
  }

  private async countActions(
    jobId: string,
  ): Promise<Record<RowAction, number>> {
    const grouped = await this.prisma.import_rows.groupBy({
      by: ['action'],
      where: { import_job_id: jobId },
      _count: { _all: true },
    });
    const counts: Record<RowAction, number> = {
      create: 0,
      update: 0,
      skip: 0,
      error: 0,
    };
    for (const group of grouped) {
      if (group.action) {
        counts[group.action] = group._count._all;
      }
    }
    return counts;
  }
}

// §6.2: phones go through libphonenumber-js region EG. An unparseable number
// becomes null rather than a rejection — the roster is names-first, and losing
// the whole row over a malformed phone would block the back-fill.
function toE164OrNull(raw: string): string | null {
  if (raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = parsePhoneNumberWithError(raw.trim(), 'EG');
    return parsed.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

function countActions(
  rows: Array<{ action?: string | null }>,
): Record<RowAction, number> {
  const counts: Record<RowAction, number> = {
    create: 0,
    update: 0,
    skip: 0,
    error: 0,
  };
  for (const row of rows) {
    if (row.action) {
      counts[row.action as RowAction] += 1;
    }
  }
  return counts;
}

function toRowView(row: {
  id: bigint;
  sheet_name: string | null;
  row_number: number;
  action: string | null;
  error_message: string | null;
  match_student_id: string | null;
  raw: Prisma.JsonValue;
  parsed: Prisma.JsonValue;
}): ImportRowView {
  return {
    // BIGSERIAL — JSON.stringify throws on a BigInt.
    id: row.id.toString(),
    sheetName: row.sheet_name,
    rowNumber: row.row_number,
    action: row.action,
    errorMessage: row.error_message,
    matchStudentId: row.match_student_id,
    raw: row.raw,
    parsed: row.parsed,
  };
}

function toJobView(
  job: {
    id: string;
    import_type: string;
    status: string;
    original_filename: string | null;
    total_rows: number | null;
    ok_rows: number | null;
    failed_rows: number | null;
    committed_at: Date | null;
    created_at: Date;
  },
  counts: Record<RowAction, number>,
): ImportJobView {
  return {
    id: job.id,
    importType: job.import_type,
    status: job.status,
    originalFilename: job.original_filename,
    totalRows: job.total_rows,
    okRows: job.ok_rows,
    failedRows: job.failed_rows,
    committedAt: job.committed_at?.toISOString() ?? null,
    createdAt: job.created_at.toISOString(),
    countsByAction: counts,
  };
}
