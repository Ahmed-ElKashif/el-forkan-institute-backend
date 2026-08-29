import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import {
  CampaignsService,
  CampaignView,
  SendOutcome,
} from './campaigns.service';
import { QueueReminderDto, UpsertTemplateDto } from './dto/messaging.schema';
import { TemplatesService, TemplateView } from './templates.service';

// §9: "Rate limiting — login, refresh, import, and the WhatsApp send path. A
// loop bug in the last one messages real people."
const SEND_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

@Controller()
export class MessagingController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly templates: TemplatesService,
  ) {}

  @Get('message-templates')
  listTemplates(): Promise<TemplateView[]> {
    return this.templates.list();
  }

  // §3: "Manage users, audit log, settings, branches, WhatsApp config" is
  // head-teacher only, and a template is what gets sent to every student.
  @Patch('message-templates/:id')
  @Roles('head_teacher')
  updateTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertTemplateDto,
    @CurrentActor() actor: Actor,
  ): Promise<TemplateView> {
    return this.templates.update(id, dto, actor);
  }

  // §3: a teacher may "Trigger / view WhatsApp sends" for their own section.
  @Post('campaigns/friday-reminder')
  @Throttle(SEND_RATE_LIMIT)
  queueReminder(
    @Body() dto: QueueReminderDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<CampaignView> {
    return this.campaigns.queueFridayReminder(
      dto.sectionId,
      dto.targetDate,
      actor,
      viewer,
    );
  }

  @Get('campaigns')
  list(@CurrentUser() viewer: AuthenticatedUser): Promise<CampaignView[]> {
    return this.campaigns.listCampaigns(viewer);
  }

  @Get('campaigns/:id')
  getCampaign(@Param('id', ParseUUIDPipe) id: string): Promise<CampaignView> {
    return this.campaigns.getCampaign(id);
  }

  @Post('campaigns/:id/send')
  @Throttle(SEND_RATE_LIMIT)
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<SendOutcome> {
    return this.campaigns.send(id, actor);
  }
}
