import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { CurriculumNode } from './curriculum-tree';
import {
  CurriculumRowView,
  CurriculumService,
  CurriculumUnitView,
} from './curriculum.service';
import {
  CreateCurriculumDto,
  CreateCurriculumUnitDto,
  ListCurriculumQueryDto,
  UpdateCurriculumDto,
  UpdateCurriculumUnitDto,
} from './dto/curriculum.schema';

// R12: the curriculum is head-teacher property. Teachers read it — they need
// the syllabus and the pass marks — but every write is restricted.
@Controller()
export class CurriculumController {
  constructor(private readonly curriculum: CurriculumService) {}

  @Get('academic-years/:yearId/curriculum')
  listTree(
    @Param('yearId', ParseIntPipe) yearId: number,
    @Query() query: ListCurriculumQueryDto,
  ): Promise<CurriculumNode<CurriculumRowView>[]> {
    return this.curriculum.listTree(yearId, query);
  }

  @Post('academic-years/:yearId/levels/:levelId/curriculum')
  @Roles('head_teacher')
  create(
    @Param('yearId', ParseIntPipe) yearId: number,
    @Param('levelId', ParseIntPipe) levelId: number,
    @Body() dto: CreateCurriculumDto,
    @CurrentActor() actor: Actor,
  ): Promise<CurriculumRowView> {
    return this.curriculum.create(yearId, levelId, dto, actor);
  }

  @Patch('curriculum/:id')
  @Roles('head_teacher')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCurriculumDto,
    @CurrentActor() actor: Actor,
  ): Promise<CurriculumRowView> {
    return this.curriculum.update(id, dto, actor);
  }

  @Delete('curriculum/:id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.curriculum.remove(id, actor);
  }

  @Post('curriculum/:id/units')
  @Roles('head_teacher')
  addUnit(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateCurriculumUnitDto,
    @CurrentActor() actor: Actor,
  ): Promise<CurriculumUnitView> {
    return this.curriculum.addUnit(id, dto, actor);
  }

  @Patch('curriculum-units/:id')
  @Roles('head_teacher')
  updateUnit(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCurriculumUnitDto,
    @CurrentActor() actor: Actor,
  ): Promise<CurriculumUnitView> {
    return this.curriculum.updateUnit(id, dto, actor);
  }

  @Delete('curriculum-units/:id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeUnit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.curriculum.removeUnit(id, actor);
  }
}
