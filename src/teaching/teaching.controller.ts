import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import {
  AbsenceWarningSummary,
  AttendanceGrid,
  AttendanceService,
} from './attendance.service';
import {
  AttendanceGridQueryDto,
  CreateClassDayDto,
  SaveAttendanceDto,
} from './dto/teaching.schema';
import { SessionsService } from './sessions.service';

// §3: scheduling class days is head-teacher only; recording attendance is a
// teacher's job on their own sections. The section scope enforces "own".
@Controller()
export class TeachingController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly sessions: SessionsService,
  ) {}

  // Per-date scheduling (R4): the head teacher builds one class day at a time.
  // Level-scoped so a `both` period reaches boys and girls in one call.
  @Post('levels/:levelId/class-days')
  @Roles('head_teacher')
  createClassDay(
    @Param('levelId', ParseIntPipe) levelId: number,
    @Body() dto: CreateClassDayDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ created: number; skipped: number }> {
    return this.sessions.createClassDay(levelId, dto, actor, viewer);
  }

  // The grid a teacher actually works in: one request renders the whole
  // student × session sheet for a term, or one class day's periods.
  @Get('sections/:id/attendance')
  getGrid(
    @Param('id', ParseUUIDPipe) sectionId: string,
    @Query() query: AttendanceGridQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<AttendanceGrid> {
    return this.attendance.getGrid(sectionId, query, viewer);
  }

  @Post('sessions/:id/attendance')
  @HttpCode(HttpStatus.OK)
  saveAttendance(
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: SaveAttendanceDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ saved: number; warnings: AbsenceWarningSummary[] }> {
    return this.attendance.saveSession(sessionId, dto, actor, viewer);
  }
}
