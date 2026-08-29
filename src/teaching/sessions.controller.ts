import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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

  // R4: a session can be moved, cancelled, or switched to online/hybrid
  // individually — the timetable is a default, not a contract.
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSessionDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<SessionView> {
    return this.sessions.update(id, dto, actor, viewer);
  }
}
