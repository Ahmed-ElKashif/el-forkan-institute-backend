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
  CreateBranchDto,
  CreateGovernorateDto,
  CreateMarkazDto,
  ListMarkazesQueryDto,
  PageQueryDto,
  UpdateBranchDto,
  UpdateGovernorateDto,
  UpdateMarkazDto,
} from './dto/geography.schema';
import {
  BranchView,
  GeographyService,
  GovernorateView,
  MarkazView,
} from './geography.service';

// Reads are open to both roles: a teacher filling in a student's markaz needs
// the list. Writes are head-teacher only (spec §3, "Manage ... branches").
@Controller()
export class GeographyController {
  constructor(private readonly geography: GeographyService) {}

  @Get('governorates')
  listGovernorates(
    @Query() query: PageQueryDto,
  ): Promise<Page<GovernorateView>> {
    return this.geography.listGovernorates(query);
  }

  @Post('governorates')
  @Roles('head_teacher')
  createGovernorate(
    @Body() dto: CreateGovernorateDto,
    @CurrentActor() actor: Actor,
  ): Promise<GovernorateView> {
    return this.geography.createGovernorate(dto, actor);
  }

  @Patch('governorates/:id')
  @Roles('head_teacher')
  updateGovernorate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGovernorateDto,
    @CurrentActor() actor: Actor,
  ): Promise<GovernorateView> {
    return this.geography.updateGovernorate(id, dto, actor);
  }

  @Get('markazes')
  listMarkazes(
    @Query() query: ListMarkazesQueryDto,
  ): Promise<Page<MarkazView>> {
    return this.geography.listMarkazes(query);
  }

  @Post('markazes')
  @Roles('head_teacher')
  createMarkaz(
    @Body() dto: CreateMarkazDto,
    @CurrentActor() actor: Actor,
  ): Promise<MarkazView> {
    return this.geography.createMarkaz(dto, actor);
  }

  @Patch('markazes/:id')
  @Roles('head_teacher')
  updateMarkaz(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMarkazDto,
    @CurrentActor() actor: Actor,
  ): Promise<MarkazView> {
    return this.geography.updateMarkaz(id, dto, actor);
  }

  @Get('branches')
  listBranches(@Query() query: PageQueryDto): Promise<Page<BranchView>> {
    return this.geography.listBranches(query);
  }

  @Post('branches')
  @Roles('head_teacher')
  createBranch(
    @Body() dto: CreateBranchDto,
    @CurrentActor() actor: Actor,
  ): Promise<BranchView> {
    return this.geography.createBranch(dto, actor);
  }

  @Patch('branches/:id')
  @Roles('head_teacher')
  updateBranch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBranchDto,
    @CurrentActor() actor: Actor,
  ): Promise<BranchView> {
    return this.geography.updateBranch(id, dto, actor);
  }
}
