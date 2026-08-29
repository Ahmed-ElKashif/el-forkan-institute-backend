import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import {
  AcademicYearView,
  CalendarService,
  TermView,
} from './calendar.service';
import {
  CreateAcademicYearDto,
  ListAcademicYearsQueryDto,
  UpdateAcademicYearDto,
  UpdateTermDto,
} from './dto/calendar.schema';

// Reads are open to both roles — a teacher needs to know which term is active.
// Creating years and terms is head-teacher only (spec §3).
@Controller()
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('academic-years')
  list(
    @Query() query: ListAcademicYearsQueryDto,
  ): Promise<Page<AcademicYearView>> {
    return this.calendar.list(query);
  }

  @Get('academic-years/:id')
  getById(@Param('id', ParseIntPipe) id: number): Promise<AcademicYearView> {
    return this.calendar.getById(id);
  }

  @Post('academic-years')
  @Roles('head_teacher')
  create(
    @Body() dto: CreateAcademicYearDto,
    @CurrentActor() actor: Actor,
  ): Promise<AcademicYearView> {
    return this.calendar.create(dto, actor);
  }

  @Patch('academic-years/:id')
  @Roles('head_teacher')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAcademicYearDto,
    @CurrentActor() actor: Actor,
  ): Promise<AcademicYearView> {
    return this.calendar.update(id, dto, actor);
  }

  @Patch('terms/:id')
  @Roles('head_teacher')
  updateTerm(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTermDto,
    @CurrentActor() actor: Actor,
  ): Promise<TermView> {
    return this.calendar.updateTerm(id, dto, actor);
  }
}
