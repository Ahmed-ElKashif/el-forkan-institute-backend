import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import {
  CreateEnrollmentDto,
  ListEnrollmentsQueryDto,
  TransferEnrollmentDto,
  UpdateEnrollmentDto,
} from './dto/section.schema';
import { EnrollmentView, SectionsService } from './sections.service';

// Spec §3: "Register students, create enrollments" is open to both roles —
// it is reversible and additive. The section-assignment scope is what keeps a
// teacher from enrolling someone into a class that is not theirs.
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly sections: SectionsService) {}

  @Get()
  list(
    @Query() query: ListEnrollmentsQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<Page<EnrollmentView>> {
    return this.sections.listEnrollments(query, viewer);
  }

  @Post()
  create(
    @Body() dto: CreateEnrollmentDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<EnrollmentView> {
    return this.sections.createEnrollment(dto, actor, viewer);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnrollmentDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<EnrollmentView> {
    return this.sections.updateEnrollment(id, dto, actor, viewer);
  }

  // Correct a wrong study year by moving the student to another section (§5).
  // `PATCH` cannot: the section is a composite-FK identity on the row. Both
  // roles, scoped to sections the viewer can reach.
  @Post(':id/transfer')
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferEnrollmentDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<EnrollmentView> {
    return this.sections.transferEnrollment(id, dto, actor, viewer);
  }
}
