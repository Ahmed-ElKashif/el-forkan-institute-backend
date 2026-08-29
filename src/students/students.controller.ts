import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { Page } from '../common/pagination';
import { DeleteWithReasonDto } from '../common/soft-delete.schema';
import {
  CreatePlacementDto,
  CreateStudentDto,
  ListStudentsQueryDto,
  UpdateStudentDto,
} from './dto/student.schema';
import {
  PlacementView,
  StudentsService,
  StudentView,
} from './students.service';

// Spec §3: registering students, editing profiles (including filling phone and
// markaz after the historical import) and recording placement are all things a
// teacher does — they are reversible and additive. Only deletion is restricted.
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  list(
    @Query() query: ListStudentsQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<Page<StudentView>> {
    return this.students.list(query, viewer);
  }

  @Get(':id')
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<StudentView> {
    return this.students.getById(id, viewer);
  }

  // Separate from the student record so a national ID is never a side effect
  // of loading a profile, and every read of one lands in the audit log.
  @Get(':id/national-id')
  @Roles('head_teacher')
  revealNationalId(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ nationalId: string | null }> {
    return this.students.revealNationalId(id, actor, viewer);
  }

  @Post()
  create(
    @Body() dto: CreateStudentDto,
    @CurrentActor() actor: Actor,
  ): Promise<StudentView> {
    return this.students.create(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<StudentView> {
    return this.students.update(id, dto, actor, viewer);
  }

  @Delete(':id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteWithReasonDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<void> {
    return this.students.softDelete(id, dto.reason, actor, viewer);
  }

  @Get(':id/placements')
  listPlacements(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PlacementView[]> {
    return this.students.listPlacements(id, viewer);
  }

  @Post(':id/placements')
  recordPlacement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePlacementDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PlacementView> {
    return this.students.recordPlacement(id, dto, actor, viewer);
  }
}
