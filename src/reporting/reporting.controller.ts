import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  AttendancePoint,
  DashboardSummary,
  HeadcountCell,
  MarkazCount,
  PassRateRow,
  ReportingService,
} from './reporting.service';

// Reads only, and scoped: a teacher's dashboard is their own sections, the
// head teacher's is the branch or the institute (spec §3, §9). No @Roles()
// here — the scope decides what each role can see, not the route.
@Controller('reports')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('summary')
  summary(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<DashboardSummary> {
    return this.reporting.summary(academicYearId, viewer);
  }

  @Get('headcount-by-level')
  headcountByLevel(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<HeadcountCell[]> {
    return this.reporting.headcountByLevel(academicYearId, viewer);
  }

  @Get('headcount-by-markaz')
  headcountByMarkaz(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<MarkazCount[]> {
    return this.reporting.headcountByMarkaz(academicYearId, viewer);
  }

  @Get('attendance-trend')
  attendanceTrend(
    @Query('termId', ParseIntPipe) termId: number,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<AttendancePoint[]> {
    return this.reporting.attendanceTrend(termId, viewer);
  }

  @Get('pass-rates')
  passRates(
    @Query('academicYearId', ParseIntPipe) academicYearId: number,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PassRateRow[]> {
    return this.reporting.passRates(academicYearId, viewer);
  }
}
