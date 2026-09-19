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
import { Page } from '../common/pagination';
import {
  AliasView,
  BookView,
  CatalogueService,
  LevelView,
  SubjectView,
} from './catalogue.service';
import {
  CreateAliasDto,
  CreateBookDto,
  CreateSubjectDto,
  ListBooksQueryDto,
  ListSubjectsQueryDto,
  UpdateBookDto,
  UpdateLevelDto,
  UpdateSubjectDto,
} from './dto/catalogue.schema';

@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('levels')
  listLevels(): Promise<LevelView[]> {
    return this.catalogue.listLevels();
  }

  @Patch('levels/:id')
  @Roles('head_teacher')
  updateLevel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLevelDto,
    @CurrentActor() actor: Actor,
  ): Promise<LevelView> {
    return this.catalogue.updateLevel(id, dto, actor);
  }

  @Get('subjects')
  listSubjects(
    @Query() query: ListSubjectsQueryDto,
  ): Promise<Page<SubjectView>> {
    return this.catalogue.listSubjects(query);
  }

  @Post('subjects')
  @Roles('head_teacher')
  createSubject(
    @Body() dto: CreateSubjectDto,
    @CurrentActor() actor: Actor,
  ): Promise<SubjectView> {
    return this.catalogue.createSubject(dto, actor);
  }

  @Patch('subjects/:id')
  @Roles('head_teacher')
  updateSubject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubjectDto,
    @CurrentActor() actor: Actor,
  ): Promise<SubjectView> {
    return this.catalogue.updateSubject(id, dto, actor);
  }

  @Post('subjects/:id/aliases')
  @Roles('head_teacher')
  addAlias(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateAliasDto,
    @CurrentActor() actor: Actor,
  ): Promise<AliasView> {
    return this.catalogue.addAlias(id, dto, actor);
  }

  /* Only a subject nothing has used yet — the service refuses the rest and says
     what is holding it. Deactivation (`PATCH`) stays the answer for a subject
     that has been taught. */
  @Delete('subjects/:id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSubject(
    @Param('id', ParseIntPipe) id: number,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.catalogue.removeSubject(id, actor);
  }

  @Delete('subject-aliases/:id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAlias(
    @Param('id', ParseIntPipe) id: number,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.catalogue.removeAlias(id, actor);
  }

  @Get('books')
  listBooks(@Query() query: ListBooksQueryDto): Promise<Page<BookView>> {
    return this.catalogue.listBooks(query);
  }

  @Post('books')
  @Roles('head_teacher')
  createBook(
    @Body() dto: CreateBookDto,
    @CurrentActor() actor: Actor,
  ): Promise<BookView> {
    return this.catalogue.createBook(dto, actor);
  }

  @Patch('books/:id')
  @Roles('head_teacher')
  updateBook(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBookDto,
    @CurrentActor() actor: Actor,
  ): Promise<BookView> {
    return this.catalogue.updateBook(id, dto, actor);
  }
}
