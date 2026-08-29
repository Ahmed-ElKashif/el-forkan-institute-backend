import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import {
  ListAuditLogsQueryDto,
  UpdateInstituteSettingsDto,
  UpsertAttendancePolicyDto,
  UpsertProgressionRuleDto,
} from './dto/settings.schema';
import {
  AttendancePolicyView,
  AuditLogView,
  ProgressionRuleView,
  SettingsService,
} from './settings.service';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // Teachers read the rules that govern their students; only the head teacher
  // sets them (spec §3, "Set carry limits (per level) & absence limits").
  @Get('academic-years/:yearId/progression-rules')
  listProgressionRules(
    @Param('yearId', ParseIntPipe) yearId: number,
  ): Promise<ProgressionRuleView[]> {
    return this.settings.listProgressionRules(yearId);
  }

  // PUT, not POST: the request names the rule by (year, level) and states the
  // whole desired state, so replaying it is a no-op rather than a duplicate.
  @Put('academic-years/:yearId/progression-rules')
  @Roles('head_teacher')
  upsertProgressionRule(
    @Param('yearId', ParseIntPipe) yearId: number,
    @Body() dto: UpsertProgressionRuleDto,
    @CurrentActor() actor: Actor,
  ): Promise<ProgressionRuleView> {
    return this.settings.upsertProgressionRule(yearId, dto, actor);
  }

  @Get('academic-years/:yearId/attendance-policies')
  listAttendancePolicies(
    @Param('yearId', ParseIntPipe) yearId: number,
  ): Promise<AttendancePolicyView[]> {
    return this.settings.listAttendancePolicies(yearId);
  }

  @Put('academic-years/:yearId/attendance-policies')
  @Roles('head_teacher')
  upsertAttendancePolicy(
    @Param('yearId', ParseIntPipe) yearId: number,
    @Body() dto: UpsertAttendancePolicyDto,
    @CurrentActor() actor: Actor,
  ): Promise<AttendancePolicyView> {
    return this.settings.upsertAttendancePolicy(yearId, dto, actor);
  }

  @Get('institute-settings')
  getInstituteSettings() {
    return this.settings.getInstituteSettings();
  }

  @Patch('institute-settings')
  @Roles('head_teacher')
  updateInstituteSettings(
    @Body() dto: UpdateInstituteSettingsDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.settings.updateInstituteSettings(dto, actor);
  }

  // The audit log is the record of who changed what; exposing it to teachers
  // would show them every other teacher's actions (spec §3, head teacher only).
  @Get('audit-logs')
  @Roles('head_teacher')
  listAuditLogs(
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<Page<AuditLogView>> {
    return this.settings.listAuditLogs(query);
  }
}
