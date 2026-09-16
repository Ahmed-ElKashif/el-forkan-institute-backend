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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import { ListSessionsQueryDto, UpdateSessionDto } from './dto/teaching.schema';
import { SessionsService, SessionView } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(
    @Query() query: ListSessionsQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<Page<SessionView>> {
    return this.sessions.list(query, viewer);
  }

  // Editing a class-day period — its subject, times, or sheikh — is head-teacher
  // work, like creating and removing one. The date-first attendance the teacher
  // takes reads these but does not change them.
  @Patch(':id')
  @Roles('head_teacher')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSessionDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<SessionView> {
    return this.sessions.update(id, dto, actor, viewer);
  }

  // Removing a period is head-teacher only: attendance cascades with it.
  @Delete(':id')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<void> {
    return this.sessions.remove(id, actor, viewer);
  }
}
