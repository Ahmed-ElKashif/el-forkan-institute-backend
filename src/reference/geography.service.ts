import { Injectable } from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { buildPage, Page, PageQuery, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateBranchDto,
  CreateGovernorateDto,
  CreateMarkazDto,
  ListMarkazesQueryDto,
  UpdateBranchDto,
  UpdateGovernorateDto,
  UpdateMarkazDto,
} from './dto/geography.schema';

export interface GovernorateView {
  id: number;
  nameAr: string;
  nameEn: string | null;
}
export interface MarkazView extends GovernorateView {
  governorateId: number;
}
export interface BranchView {
  id: number;
  nameAr: string;
  governorateId: number | null;
  isActive: boolean;
}

@Injectable()
export class GeographyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listGovernorates(query: PageQuery): Promise<Page<GovernorateView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.governorates.findMany({
        orderBy: { name_ar: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.governorates.count(),
    ]);
    return buildPage(rows.map(toGovernorate), total, query);
  }

  async createGovernorate(
    dto: CreateGovernorateDto,
    actor: Actor,
  ): Promise<GovernorateView> {
    const created = await this.prisma.governorates.create({
      data: { name_ar: dto.nameAr, name_en: dto.nameEn },
    });
    await this.audit.record(actor, {
      action: 'governorate.create',
      entityType: 'governorate',
      entityId: String(created.id),
      after: toGovernorate(created),
    });
    return toGovernorate(created);
  }

  async updateGovernorate(
    id: number,
    dto: UpdateGovernorateDto,
    actor: Actor,
  ): Promise<GovernorateView> {
    const before = await this.prisma.governorates.findUniqueOrThrow({
      where: { id },
    });
    const updated = await this.prisma.governorates.update({
      where: { id },
      data: { name_ar: dto.nameAr, name_en: dto.nameEn },
    });
    await this.audit.record(actor, {
      action: 'governorate.update',
      entityType: 'governorate',
      entityId: String(id),
      before: toGovernorate(before),
      after: toGovernorate(updated),
    });
    return toGovernorate(updated);
  }

  async listMarkazes(query: ListMarkazesQueryDto): Promise<Page<MarkazView>> {
    const where = query.governorateId
      ? { governorate_id: query.governorateId }
      : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.markazes.findMany({
        where,
        orderBy: { name_ar: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.markazes.count({ where }),
    ]);
    return buildPage(rows.map(toMarkaz), total, query);
  }

  async createMarkaz(dto: CreateMarkazDto, actor: Actor): Promise<MarkazView> {
    const created = await this.prisma.markazes.create({
      data: {
        governorate_id: dto.governorateId,
        name_ar: dto.nameAr,
        name_en: dto.nameEn,
      },
    });
    await this.audit.record(actor, {
      action: 'markaz.create',
      entityType: 'markaz',
      entityId: String(created.id),
      after: toMarkaz(created),
    });
    return toMarkaz(created);
  }

  async updateMarkaz(
    id: number,
    dto: UpdateMarkazDto,
    actor: Actor,
  ): Promise<MarkazView> {
    const before = await this.prisma.markazes.findUniqueOrThrow({
      where: { id },
    });
    const updated = await this.prisma.markazes.update({
      where: { id },
      data: { name_ar: dto.nameAr, name_en: dto.nameEn },
    });
    await this.audit.record(actor, {
      action: 'markaz.update',
      entityType: 'markaz',
      entityId: String(id),
      before: toMarkaz(before),
      after: toMarkaz(updated),
    });
    return toMarkaz(updated);
  }

  async listBranches(query: PageQuery): Promise<Page<BranchView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.branches.findMany({
        orderBy: { name_ar: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.branches.count(),
    ]);
    return buildPage(rows.map(toBranch), total, query);
  }

  async createBranch(dto: CreateBranchDto, actor: Actor): Promise<BranchView> {
    const created = await this.prisma.branches.create({
      data: { name_ar: dto.nameAr, governorate_id: dto.governorateId },
    });
    await this.audit.record(actor, {
      action: 'branch.create',
      entityType: 'branch',
      entityId: String(created.id),
      after: toBranch(created),
    });
    return toBranch(created);
  }

  async updateBranch(
    id: number,
    dto: UpdateBranchDto,
    actor: Actor,
  ): Promise<BranchView> {
    const before = await this.prisma.branches.findUniqueOrThrow({
      where: { id },
    });
    const updated = await this.prisma.branches.update({
      where: { id },
      data: {
        name_ar: dto.nameAr,
        governorate_id: dto.governorateId,
        is_active: dto.isActive,
      },
    });
    await this.audit.record(actor, {
      action: 'branch.update',
      entityType: 'branch',
      entityId: String(id),
      before: toBranch(before),
      after: toBranch(updated),
    });
    return toBranch(updated);
  }
}

function toGovernorate(row: {
  id: number;
  name_ar: string;
  name_en: string | null;
}): GovernorateView {
  return { id: row.id, nameAr: row.name_ar, nameEn: row.name_en };
}

function toMarkaz(row: {
  id: number;
  governorate_id: number;
  name_ar: string;
  name_en: string | null;
}): MarkazView {
  return { ...toGovernorate(row), governorateId: row.governorate_id };
}

function toBranch(row: {
  id: number;
  name_ar: string;
  governorate_id: number | null;
  is_active: boolean;
}): BranchView {
  return {
    id: row.id,
    nameAr: row.name_ar,
    governorateId: row.governorate_id,
    isActive: row.is_active,
  };
}
