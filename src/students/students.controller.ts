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
import {
  AttendanceSummaryView,
  CarriedSubjectGroupView,
  EnrollmentHistoryView,
  ExamResultView,
  StudentRecordsService,
} from './student-records.service';

// Spec §3: registering students, editing profiles (including filling phone and
// markaz after the historical import) and recording placement are all things a
// teacher does — they are reversible and additive. Only deletion is restricted.
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly records: StudentRecordsService,
  ) {}

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
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<StudentView> {
    return this.students.create(dto, actor, viewer);
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

  // The four profile record panels. Reads only — both roles may view a student
  // they can reach; the record services gate on the same branch visibility as
  // the profile itself.
  @Get(':id/enrollments')
  enrollmentHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<EnrollmentHistoryView[]> {
    return this.records.enrollmentHistory(id, viewer);
  }

  @Get(':id/attendance')
  attendanceSummary(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<AttendanceSummaryView> {
    return this.records.attendanceSummary(id, viewer);
  }

  @Get(':id/exam-results')
  examResults(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ExamResultView[]> {
    return this.records.examResults(id, viewer);
  }

  @Get(':id/carried-subjects')
  carriedSubjects(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<CarriedSubjectGroupView[]> {
    return this.records.carriedSubjects(id, viewer);
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
