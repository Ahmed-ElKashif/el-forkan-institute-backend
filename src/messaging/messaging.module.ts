import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { MessagingController } from './messaging.controller';
import { ReminderScheduler } from './reminder.scheduler';
import { TemplatesService } from './templates.service';
import { WhatsAppClient } from './whatsapp.client';

@Module({
  controllers: [MessagingController],
  providers: [
    CampaignsService,
    TemplatesService,
    WhatsAppClient,
    ReminderScheduler,
  ],
})
export class MessagingModule {}
