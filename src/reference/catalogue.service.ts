import { ConflictException, Injectable } from '@nestjs/common';
import { normalizeArabic } from '../common/arabic';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { buildPage, Page, PageQuery, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateAliasDto,
  CreateBookDto,
  CreateSubjectDto,
  ListSubjectsQueryDto,
  UpdateBookDto,
  UpdateLevelDto,
  UpdateSubjectDto,
} from './dto/catalogue.schema';

export interface LevelView {
  id: number;
  code: string;
  nameAr: string;
  sortOrder: number;
  isOptional: boolean;
  isTerminal: boolean;
  allowsCarry: boolean;
  grantsCertificate: boolean;
  requiresCleanEntry: boolean;
}

export interface AliasView {
  id: number;
  aliasAr: string;
  normalized: string;
}

export interface SubjectView {
  id: number;
  code: string;
  nameAr: string;
  shortNameAr: string | null;
  nameEn: string | null;
  isActive: boolean;
  aliases: AliasView[];
}

export interface BookView {
  id: number;
  titleAr: string;
  authorAr: string | null;
  notes: string | null;
  isActive: boolean;
}

@Injectable()
export class CatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listLevels(): Promise<LevelView[]> {
    // Six rows, fixed by R1 — a page parameter here would be noise.
    const rows = await this.prisma.levels.findMany({
      orderBy: { sort_order: 'asc' },
    });
    return rows.map(toLevel);
  }

  async updateLevel(
    id: number,
    dto: UpdateLevelDto,
    actor: Actor,
  ): Promise<LevelView> {
    const before = await this.prisma.levels.findUniqueOrThrow({
      where: { id },
    });
    const updated = await this.prisma.levels.update({
      where: { id },
      data: {
        name_ar: dto.nameAr,
        is_optional: dto.isOptional,
        is_terminal: dto.isTerminal,
        allows_carry: dto.allowsCarry,
        grants_certificate: dto.grantsCertificate,
        requires_clean_entry: dto.requiresCleanEntry,
      },
    });
    await this.audit.record(actor, {
      action: 'level.update',
      entityType: 'level',
      entityId: String(id),
      before: toLevel(before),
      after: toLevel(updated),
    });
    return toLevel(updated);
  }

  async listSubjects(query: ListSubjectsQueryDto): Promise<Page<SubjectView>> {
    const where = {
      ...(query.includeInactive ? {} : { is_active: true }),
      ...(query.search
        ? {
            OR: [
              { name_ar: { contains: query.search } },
              {
                code: { contains: query.search, mode: 'insensitive' as const },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.subjects.findMany({
        where,
        // One query, not one per subject: the alias list is part of what a
        // subject is for the import path.
        include: { subject_aliases: true },
        orderBy: { name_ar: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.subjects.count({ where }),
    ]);
    return buildPage(rows.map(toSubject), total, query);
  }

  async createSubject(
    dto: CreateSubjectDto,
    actor: Actor,
  ): Promise<SubjectView> {
    const created = await this.prisma.subjects.create({
      data: {
        code: dto.code,
        name_ar: dto.nameAr,
        short_name_ar: dto.shortNameAr,
        name_en: dto.nameEn,
        // Seed the alias table with what the subject is actually called on the
        // sheets, so the import resolves it without anyone remembering to.
        subject_aliases: {
          create: aliasRowsFor([dto.nameAr, dto.shortNameAr]),
        },
      },
      include: { subject_aliases: true },
    });
    await this.audit.record(actor, {
      action: 'subject.create',
      entityType: 'subject',
      entityId: String(created.id),
      after: toSubject(created),
    });
    return toSubject(created);
  }

  async updateSubject(
    id: number,
    dto: UpdateSubjectDto,
    actor: Actor,
  ): Promise<SubjectView> {
    const before = await this.prisma.subjects.findUniqueOrThrow({
      where: { id },
      include: { subject_aliases: true },
    });
    const updated = await this.prisma.subjects.update({
      where: { id },
      data: {
        name_ar: dto.nameAr,
        short_name_ar: dto.shortNameAr,
        name_en: dto.nameEn,
        is_active: dto.isActive,
      },
      include: { subject_aliases: true },
    });
    await this.audit.record(actor, {
      action: 'subject.update',
      entityType: 'subject',
      entityId: String(id),
      before: toSubject(before),
      after: toSubject(updated),
    });
    return toSubject(updated);
  }

  async addAlias(
    subjectId: number,
    dto: CreateAliasDto,
    actor: Actor,
  ): Promise<AliasView> {
    const normalized = normalizeArabic(dto.aliasAr);
    if (normalized.length === 0) {
      throw new ConflictException(
        'Alias normalises to an empty string and would match everything',
      );
    }
    const created = await this.prisma.subject_aliases.create({
      data: { subject_id: subjectId, alias_ar: dto.aliasAr, normalized },
    });
    await this.audit.record(actor, {
      action: 'subject.alias.add',
      entityType: 'subject',
      entityId: String(subjectId),
      after: toAlias(created),
    });
    return toAlias(created);
  }

  async removeAlias(aliasId: number, actor: Actor): Promise<void> {
    const before = await this.prisma.subject_aliases.findUniqueOrThrow({
      where: { id: aliasId },
    });
    await this.prisma.subject_aliases.delete({ where: { id: aliasId } });
    await this.audit.record(actor, {
      action: 'subject.alias.remove',
      entityType: 'subject',
      entityId: String(before.subject_id),
      before: toAlias(before),
    });
  }

  async listBooks(query: PageQuery): Promise<Page<BookView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.books.findMany({
        orderBy: { title_ar: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.books.count(),
    ]);
    return buildPage(rows.map(toBook), total, query);
  }

  async createBook(dto: CreateBookDto, actor: Actor): Promise<BookView> {
    const created = await this.prisma.books.create({
      data: {
        title_ar: dto.titleAr,
        author_ar: dto.authorAr,
        notes: dto.notes,
      },
    });
    await this.audit.record(actor, {
      action: 'book.create',
      entityType: 'book',
      entityId: String(created.id),
      after: toBook(created),
    });
    return toBook(created);
  }

  async updateBook(
    id: number,
    dto: UpdateBookDto,
    actor: Actor,
  ): Promise<BookView> {
    const before = await this.prisma.books.findUniqueOrThrow({ where: { id } });
    const updated = await this.prisma.books.update({
      where: { id },
      data: {
        title_ar: dto.titleAr,
        author_ar: dto.authorAr,
        notes: dto.notes,
        is_active: dto.isActive,
      },
    });
    await this.audit.record(actor, {
      action: 'book.update',
      entityType: 'book',
      entityId: String(id),
      before: toBook(before),
      after: toBook(updated),
    });
    return toBook(updated);
  }
}

// subject_aliases.normalized is UNIQUE, so a name and its short form that
// normalise to the same key must not both be inserted.
function aliasRowsFor(
  candidates: Array<string | undefined>,
): Array<{ alias_ar: string; normalized: string }> {
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeArabic(candidate);
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.set(normalized, candidate);
    }
  }
  return [...seen].map(([normalized, aliasAr]) => ({
    alias_ar: aliasAr,
    normalized,
  }));
}

function toLevel(row: {
  id: number;
  code: string;
  name_ar: string;
  sort_order: number;
  is_optional: boolean;
  is_terminal: boolean;
  allows_carry: boolean;
  grants_certificate: boolean;
  requires_clean_entry: boolean;
}): LevelView {
  return {
    id: row.id,
    code: row.code,
    nameAr: row.name_ar,
    sortOrder: row.sort_order,
    isOptional: row.is_optional,
    isTerminal: row.is_terminal,
    allowsCarry: row.allows_carry,
    grantsCertificate: row.grants_certificate,
    requiresCleanEntry: row.requires_clean_entry,
  };
}

function toAlias(row: {
  id: number;
  alias_ar: string;
  normalized: string;
}): AliasView {
  return { id: row.id, aliasAr: row.alias_ar, normalized: row.normalized };
}

function toSubject(row: {
  id: number;
  code: string;
  name_ar: string;
  short_name_ar: string | null;
  name_en: string | null;
  is_active: boolean;
  subject_aliases: Array<{ id: number; alias_ar: string; normalized: string }>;
}): SubjectView {
  return {
    id: row.id,
    code: row.code,
    nameAr: row.name_ar,
    shortNameAr: row.short_name_ar,
    nameEn: row.name_en,
    isActive: row.is_active,
    aliases: row.subject_aliases.map(toAlias),
  };
}

function toBook(row: {
  id: number;
  title_ar: string;
  author_ar: string | null;
  notes: string | null;
  is_active: boolean;
}): BookView {
  return {
    id: row.id,
    titleAr: row.title_ar,
    authorAr: row.author_ar,
    notes: row.notes,
    isActive: row.is_active,
  };
}
