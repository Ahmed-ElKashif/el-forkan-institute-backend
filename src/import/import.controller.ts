import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import { MAX_FILE_BYTES } from '../excel/workbook-loader';
import {
  FixImportRowDto,
  ListImportRowsQueryDto,
  StartImportDto,
} from './dto/import.schema';
import { ImportJobView, ImportRowView, ImportService } from './import.service';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// R11: both roles may import. Spec §9 puts the import path on the rate-limit
// list — a parse is far more expensive than an ordinary request, and the file
// arrives from outside.
const IMPORT_RATE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@Controller('imports')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Post()
  @Throttle(IMPORT_RATE_LIMIT)
  @UseInterceptors(
    FileInterceptor('file', {
      // Multer enforces this before the buffer is ever fully in memory;
      // loadWorkbook checks it again because it is also callable directly.
      limits: { fileSize: MAX_FILE_BYTES, files: 1 },
    }),
  )
  preview(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: StartImportDto,
    @CurrentActor() actor: Actor,
  ): Promise<ImportJobView> {
    return this.imports.preview(assertXlsx(file), dto, actor);
  }

  @Get(':id')
  getJob(@Param('id', ParseUUIDPipe) id: string): Promise<ImportJobView> {
    return this.imports.getJob(id);
  }

  @Get(':id/rows')
  listRows(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListImportRowsQueryDto,
  ): Promise<Page<ImportRowView>> {
    return this.imports.listRows(id, query);
  }

  @Patch('rows/:rowId')
  fixRow(
    @Param('rowId') rowId: string,
    @Body() dto: FixImportRowDto,
    @CurrentActor() actor: Actor,
  ): Promise<ImportRowView> {
    return this.imports.fixRow(toRowId(rowId), dto, actor);
  }

  // Separate from the upload on purpose: §6.3's whole point is that a human
  // looks at the preview between the two.
  @Post(':id/commit')
  @Throttle(IMPORT_RATE_LIMIT)
  commit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartImportDto,
    @CurrentActor() actor: Actor,
  ): Promise<ImportJobView> {
    return this.imports.commit(id, dto, actor);
  }
}

/**
 * The MIME type is what the browser claimed, so it is a convenience check
 * rather than a security boundary — `loadWorkbook` refusing to parse a
 * non-workbook is the real one. Checking it here turns "unhandled zip error"
 * into a message naming the actual problem.
 */
function assertXlsx(
  file: Express.Multer.File | undefined,
): Express.Multer.File {
  if (!file) {
    throw new BadRequestException(
      'No file was uploaded under the "file" field',
    );
  }
  if (file.mimetype !== XLSX_MIME) {
    throw new BadRequestException(
      'Upload an .xlsx workbook; .xls and .csv are not supported',
    );
  }
  return file;
}

// import_rows.id is BIGSERIAL, so it arrives as a decimal string.
function toRowId(raw: string): bigint {
  if (!/^\d{1,19}$/.test(raw)) {
    throw new BadRequestException('Row id must be a positive integer');
  }
  return BigInt(raw);
}
