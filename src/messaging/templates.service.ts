import { Injectable } from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpsertTemplateDto } from './dto/messaging.schema';

export interface TemplateView {
  id: number;
  code: string;
  channel: string;
  language: string;
  body: string;
  providerTemplateName: string | null;
  variables: unknown;
  isActive: boolean;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<TemplateView[]> {
    const rows = await this.prisma.message_templates.findMany({
      orderBy: { code: 'asc' },
    });
    return rows.map(toTemplateView);
  }

  // `code` is absent: it is how the application finds a template
  // (friday_schedule, absence_warning), so renaming one would silently stop
  // the cron from finding anything to send.
  async update(
    id: number,
    dto: UpsertTemplateDto,
    actor: Actor,
  ): Promise<TemplateView> {
    const before = await this.prisma.message_templates.findUniqueOrThrow({
      where: { id },
    });
    const updated = await this.prisma.message_templates.update({
      where: { id },
      data: {
        body: dto.body,
        provider_template_name: dto.providerTemplateName,
        language: dto.language,
        is_active: dto.isActive,
      },
    });
    await this.audit.record(actor, {
      action: 'message_template.update',
      entityType: 'message_template',
      entityId: String(id),
      before: toTemplateView(before),
      after: toTemplateView(updated),
    });
    return toTemplateView(updated);
  }
}

function toTemplateView(row: {
  id: number;
  code: string;
  channel: string;
  language: string;
  body: string;
  provider_template_name: string | null;
  variables: unknown;
  is_active: boolean;
}): TemplateView {
  return {
    id: row.id,
    code: row.code,
    channel: row.channel,
    language: row.language,
    body: row.body,
    providerTemplateName: row.provider_template_name,
    variables: row.variables,
    isActive: row.is_active,
  };
}
