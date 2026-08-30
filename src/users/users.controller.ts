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
  ChangePasswordDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetPasswordDto,
  UpdateUserDto,
} from './dto/user.schema';
import { PublicUser } from './users.mapper';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Declared before :id — Express matches routes in order, so a later
  // /users/:id would swallow /users/me and try to parse "me" as a UUID.
  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<PublicUser> {
    return this.usersService.getProfile(user.id);
  }

  // Declared before :id routes so "me" is never parsed as a UUID. F10: any
  // authenticated user may change their own password with the current one.
  @Post('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changeMyPassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.usersService.changeOwnPassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      actor,
    );
  }

  @Get()
  @Roles('head_teacher')
  list(
    @Query() query: ListUsersQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<Page<PublicUser>> {
    return this.usersService.list(query, viewer);
  }

  @Get(':id')
  @Roles('head_teacher')
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PublicUser> {
    return this.usersService.getById(id, viewer);
  }

  @Post()
  @Roles('head_teacher')
  create(
    @Body() dto: CreateUserDto,
    @CurrentActor() actor: Actor,
  ): Promise<PublicUser> {
    return this.usersService.create(dto, actor);
  }

  @Patch(':id')
  @Roles('head_teacher')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PublicUser> {
    return this.usersService.update(id, dto, actor, viewer);
  }

  // F10: the head teacher resets a user's password without recreating them.
  @Post(':id/password')
  @Roles('head_teacher')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<void> {
    return this.usersService.resetPassword(id, dto.newPassword, actor, viewer);
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
    return this.usersService.softDelete(id, dto.reason, actor, viewer);
  }
}
