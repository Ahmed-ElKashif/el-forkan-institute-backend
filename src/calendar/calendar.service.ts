import { BadRequestException, Injectable } from '@nestjs/common';
import type { Actor } from '../common/actor.decorator';
import { AuditService } from '../common/audit.service';
import { toDateOnlyString } from '../common/date-only.schema';
import { buildPage, Page, PageQuery, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
  UpdateTermDto,
} from './dto/calendar.schema';
import { planAcademicYear } from './year-planner';

export interface TermView {
  id: number;
  academicYearId: number;
  termNumber: number;
  startsOn: string;
  endsOn: string;
  examStartsOn: string | null;
  examEndsOn: string | null;
  status: string;
}

export interface AcademicYearView {
  id: number;
  hijriYear: number;
  startsOn: string;
  endsOn: string;
  status: string;
  terms: TermView[];
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: PageQuery): Promise<Page<AcademicYearView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.academic_years.findMany({
        include: { terms: { orderBy: { term_number: 'asc' } } },
        orderBy: { hijri_year: 'desc' },
        ...toPrismaPage(query),
      }),
      this.prisma.academic_years.count(),
    ]);
    return buildPage(rows.map(toAcademicYear), total, query);
  }

  async getById(id: number): Promise<AcademicYearView> {
    return toAcademicYear(
      await this.prisma.academic_years.findUniqueOrThrow({
        where: { id },
        include: { terms: { orderBy: { term_number: 'asc' } } },
      }),
    );
  }

  /**
   * Creates the year and both of its terms in one transaction. R6 says a year
   * *has* two terms; a year row without them is not a valid state for anything
   * downstream (curriculum, exams, attendance warnings) to read.
   */
  async create(
    dto: CreateAcademicYearDto,
    actor: Actor,
  ): Promise<AcademicYearView> {
    const settings = await this.prisma.institute_settings.findUniqueOrThrow({
      where: { id: 1 },
    });
    const suggested = planAcademicYear(dto.hijriYear, {
      yearStartHijriMonth: settings.year_start_hijri_month,
      yearStartHijriDay: settings.year_start_hijri_day,
      yearEndHijriMonth: settings.year_end_hijri_month,
      yearEndHijriDay: settings.year_end_hijri_day,
    });

    const startsOn = dto.startsOn ?? suggested.startsOn;
    const endsOn = dto.endsOn ?? suggested.endsOn;
    // A partial override (only one of the two dates) can invert the year even
    // though each date is individually valid, and the DDL's CHECK would
    // surface that as an unmapped driver error rather than a 400.
    if (endsOn <= startsOn) {
      throw new BadRequestException('endsOn must be after startsOn');
    }

    const created = await this.prisma.academic_years.create({
      data: {
        hijri_year: dto.hijriYear,
        starts_on: startsOn,
        ends_on: endsOn,
        created_by: actor.userId,
        updated_by: actor.userId,
        terms: {
          create: suggested.terms.map((term) => ({
            term_number: term.termNumber,
            starts_on: clamp(term.startsOn, startsOn, endsOn),
            ends_on: clamp(term.endsOn, startsOn, endsOn),
            exam_starts_on: clamp(term.examStartsOn, startsOn, endsOn),
            exam_ends_on: clamp(term.examEndsOn, startsOn, endsOn),
            updated_by: actor.userId,
          })),
        },
      },
      include: { terms: { orderBy: { term_number: 'asc' } } },
    });

    const view = toAcademicYear(created);
    await this.audit.record(actor, {
      action: 'academic_year.create',
      entityType: 'academic_year',
      entityId: String(created.id),
      after: view,
    });
    return view;
  }

  async update(
    id: number,
    dto: UpdateAcademicYearDto,
    actor: Actor,
  ): Promise<AcademicYearView> {
    const before = await this.prisma.academic_years.findUniqueOrThrow({
      where: { id },
      include: { terms: { orderBy: { term_number: 'asc' } } },
    });
    const startsOn = dto.startsOn ?? before.starts_on;
    const endsOn = dto.endsOn ?? before.ends_on;
    if (endsOn <= startsOn) {
      throw new BadRequestException('endsOn must be after startsOn');
    }

    const updated = await this.prisma.academic_years.update({
      where: { id },
      data: {
        starts_on: dto.startsOn,
        ends_on: dto.endsOn,
        status: dto.status,
        updated_by: actor.userId,
        updated_at: new Date(),
      },
      include: { terms: { orderBy: { term_number: 'asc' } } },
    });

    const view = toAcademicYear(updated);
    await this.audit.record(actor, {
      action: 'academic_year.update',
      entityType: 'academic_year',
      entityId: String(id),
      before: toAcademicYear(before),
      after: view,
    });
    return view;
  }

  async updateTerm(
    id: number,
    dto: UpdateTermDto,
    actor: Actor,
  ): Promise<TermView> {
    const before = await this.prisma.terms.findUniqueOrThrow({ where: { id } });
    const startsOn = dto.startsOn ?? before.starts_on;
    const endsOn = dto.endsOn ?? before.ends_on;
    if (endsOn <= startsOn) {
      throw new BadRequestException('endsOn must be after startsOn');
    }

    const examStartsOn =
      dto.examStartsOn === undefined ? before.exam_starts_on : dto.examStartsOn;
    const examEndsOn =
      dto.examEndsOn === undefined ? before.exam_ends_on : dto.examEndsOn;
    if (examStartsOn && examEndsOn && examEndsOn < examStartsOn) {
      throw new BadRequestException(
        'examEndsOn must be on or after examStartsOn',
      );
    }

    const updated = await this.prisma.terms.update({
      where: { id },
      data: {
        starts_on: dto.startsOn,
        ends_on: dto.endsOn,
        exam_starts_on: dto.examStartsOn,
        exam_ends_on: dto.examEndsOn,
        status: dto.status,
        updated_by: actor.userId,
        updated_at: new Date(),
      },
    });

    await this.audit.record(actor, {
      action: 'term.update',
      entityType: 'term',
      entityId: String(id),
      before: toTerm(before),
      after: toTerm(updated),
    });
    return toTerm(updated);
  }
}

// A head-teacher override can shorten the year past a suggested term boundary;
// the suggestion has to fold inside the real year rather than fail.
function clamp(value: Date, lower: Date, upper: Date): Date {
  if (value < lower) return lower;
  if (value > upper) return upper;
  return value;
}

interface TermRow {
  id: number;
  academic_year_id: number;
  term_number: number;
  starts_on: Date;
  ends_on: Date;
  exam_starts_on: Date | null;
  exam_ends_on: Date | null;
  status: string;
}

function toTerm(row: TermRow): TermView {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    termNumber: row.term_number,
    startsOn: toDateOnlyString(row.starts_on),
    endsOn: toDateOnlyString(row.ends_on),
    examStartsOn: row.exam_starts_on && toDateOnlyString(row.exam_starts_on),
    examEndsOn: row.exam_ends_on && toDateOnlyString(row.exam_ends_on),
    status: row.status,
  };
}

function toAcademicYear(row: {
  id: number;
  hijri_year: number;
  starts_on: Date;
  ends_on: Date;
  status: string;
  terms: TermRow[];
}): AcademicYearView {
  return {
    id: row.id,
    hijriYear: row.hijri_year,
    startsOn: toDateOnlyString(row.starts_on),
    endsOn: toDateOnlyString(row.ends_on),
    status: row.status,
    terms: row.terms.map(toTerm),
  };
}
