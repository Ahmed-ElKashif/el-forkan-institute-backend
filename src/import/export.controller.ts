import {
  Controller,
  Get,
  Header,
  ParseIntPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { ExportService, type ExportPreview } from './export.service';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('exports')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  /* The preview routes mirror §6.3's preview-then-commit, and are the ordinary
     way in: read the rows, then download. Plain JSON — no `@Header`, no
     `StreamableFile` — because nothing is leaving the building yet, which is
     also why they write no audit row. Scoped exactly like the downloads: both
     go through `loadScope`, so a teacher previews only their own sections. */
  @Get('roster/preview')
  previewRoster(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @Query('levelId') levelId: string | undefined,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ExportPreview> {
    return this.exports.previewRoster(
      academicYearId,
      toOptionalId(levelId),
      viewer,
    );
  }

  @Get('results/preview')
  previewResults(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @Query('levelId') levelId: string | undefined,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ExportPreview> {
    return this.exports.previewResults(
      academicYearId,
      toOptionalId(levelId),
      viewer,
    );
  }

  @Get('roster')
  @Header('Content-Type', XLSX_MIME)
  async roster(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @Query('levelId') levelId: string | undefined,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.exports.exportRoster(
      academicYearId,
      toOptionalId(levelId),
      actor,
      viewer,
    );
    setDownloadName(res, result.filename);
    // StreamableFile, not a bare Buffer: Nest's default serializer would
    // JSON-encode a Buffer into {"type":"Buffer","data":[...]}, producing a
    // response whose Content-Type says xlsx but whose body is JSON.
    return new StreamableFile(result.buffer);
  }

  @Get('results')
  @Header('Content-Type', XLSX_MIME)
  async results(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @Query('levelId') levelId: string | undefined,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.exports.exportResults(
      academicYearId,
      toOptionalId(levelId),
      actor,
      viewer,
    );
    setDownloadName(res, result.filename);
    return new StreamableFile(result.buffer);
  }
}

function toOptionalId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// The filename is generated from a Hijri year and a numeric level, never from
// user input, so it cannot carry a header-injection payload.
function setDownloadName(res: Response, filename: string): void {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}
