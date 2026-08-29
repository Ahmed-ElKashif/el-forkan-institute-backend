import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
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
  CreateTimetableSlotDto,
  GenerateSessionsDto,
  SaveAttendanceDto,
  UpdateTimetableSlotDto,
} from './dto/teaching.schema';
import { TimetableService, TimetableSlotView } from './timetable.service';

// §3: "Set the timetable" is head-teacher only; recording attendance is a
// teacher's job on their own sections. The section scope enforces "own".
@Controller()
export class TeachingController {
  constructor(
    private readonly timetable: TimetableService,
    private readonly attendance: AttendanceService,
  ) {}

  @Get('sections/:id/timetable')
  listSlots(
    @Param('id', ParseUUIDPipe) sectionId: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<TimetableSlotView[]> {
    return this.timetable.list(sectionId, viewer);
  }

  @Post('sections/:id/timetable')
  @Roles('head_teacher')
  createSlot(
    @Param('id', ParseUUIDPipe) sectionId: string,
    @Body() dto: CreateTimetableSlotDto,
    @CurrentActor() actor: Actor,
  ): Promise<TimetableSlotView> {
    return this.timetable.create(sectionId, dto, actor);
  }

  @Patch('timetable-slots/:id')
  @Roles('head_teacher')
  updateSlot(
    @Param('id', ParseUUIDPipe) slotId: string,
    @Body() dto: UpdateTimetableSlotDto,
    @CurrentActor() actor: Actor,
  ): Promise<TimetableSlotView> {
    return this.timetable.update(slotId, dto, actor);
  }

  @Delete('timetable-slots/:id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSlot(
    @Param('id', ParseUUIDPipe) slotId: string,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.timetable.remove(slotId, actor);
  }

  @Post('sections/:id/sessions/generate')
  @Roles('head_teacher')
  generateSessions(
    @Param('id', ParseUUIDPipe) sectionId: string,
    @Body() dto: GenerateSessionsDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ created: number; skipped: number }> {
    return this.timetable.generateSessions(sectionId, dto, actor);
  }

  // The grid a teacher actually works in: one request renders the whole
  // student × session sheet for a term.
  @Get('sections/:id/attendance')
  getGrid(
    @Param('id', ParseUUIDPipe) sectionId: string,
    @Query('termId', ParseIntPipe) termId: number,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<AttendanceGrid> {
    return this.attendance.getGrid(sectionId, termId, viewer);
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
