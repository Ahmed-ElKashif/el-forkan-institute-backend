import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './actor.decorator';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

// Written by services rather than by an interceptor: an interceptor sees the
// request and the response, never the row as it looked *before* the write, and
// `audit_logs.before` is the column that makes a grade change (R8) or a soft
// delete (R9) reconstructable.
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(actor: Actor, entry: AuditEntry): Promise<void> {
    await this.prisma.audit_logs.create({
      data: {
        actor_id: actor.userId,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        before: toJsonColumn(entry.before),
        after: toJsonColumn(entry.after),
        ip_address: actor.ipAddress,
        user_agent: actor.userAgent,
      },
    });
  }
}

// Prisma's Json column rejects `undefined` but accepts an explicit SQL NULL,
// and Decimal/Date values need collapsing to primitives before they land in
// JSONB.
function toJsonColumn(value: unknown): object | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as object;
}
