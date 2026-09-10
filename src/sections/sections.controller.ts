import {
  BadRequestException,
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
import { resolveWritableBranch } from '../common/access-scope';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import {
  AssignTeacherDto,
  CreateSectionDto,
  ListSectionsQueryDto,
  ProvisionSectionsDto,
  UpdateSectionDto,
} from './dto/section.schema';
import {
  PhoneCoverage,
  SectionsService,
  SectionView,
} from './sections.service';

// Spec §3: "Create sections, assign teachers" is head-teacher only. Reads are
// scoped, not restricted — a teacher gets their own sections back, which is
// enforced in the repository layer by sectionScope(), never here.
@Controller('sections')
export class SectionsController {
  constructor(private readonly sections: SectionsService) {}

  @Get()
  list(
    @Query() query: ListSectionsQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<Page<SectionView>> {
    return this.sections.list(query, viewer);
  }

  @Get(':id')
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<SectionView> {
    return this.sections.getById(id, viewer);
  }

  @Get(':id/phone-coverage')
  phoneCoverage(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PhoneCoverage> {
    return this.sections.phoneCoverage(id, viewer);
  }

  /* Creates the year's whole class list in one call — one per level per gender.
     Ahead of `create` in the file because this is how classes are meant to come
     into existence; `create` is the exception, not the rule. */
  @Post('provision')
  @Roles('head_teacher')
  async provision(
    @Body() dto: ProvisionSectionsDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ created: number; total: number }> {
    const branchId = resolveWritableBranch(viewer, dto.branchId);
    if (branchId === null) {
      throw new BadRequestException(
        'A branch is required: this account is not bound to one, so it must name the branch to provision',
      );
    }
    return this.sections.provisionYear(dto.academicYearId, branchId, actor);
  }

  @Post()
  @Roles('head_teacher')
  create(
    @Body() dto: CreateSectionDto,
    @CurrentActor() actor: Actor,
  ): Promise<SectionView> {
    return this.sections.create(dto, actor);
  }

  @Patch(':id')
  @Roles('head_teacher')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSectionDto,
    @CurrentActor() actor: Actor,
  ): Promise<SectionView> {
    return this.sections.update(id, dto, actor);
  }

  @Post(':id/teachers')
  @Roles('head_teacher')
  assignTeacher(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTeacherDto,
    @CurrentActor() actor: Actor,
  ): Promise<SectionView> {
    return this.sections.assignTeacher(id, dto, actor);
  }

  @Delete(':id/teachers/:userId')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  unassignTeacher(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.sections.unassignTeacher(id, userId, actor);
  }
}
