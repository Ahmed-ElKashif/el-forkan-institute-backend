import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentActor } from '../common/actor.decorator';
import type { Actor } from '../common/actor.decorator';
import { Page } from '../common/pagination';
import {
  ConfirmPromotionDto,
  CorrectScoreDto,
  CreateExamDto,
  IssueCertificateDto,
  ListExamsQueryDto,
  OverrideEligibilityDto,
  RevokeCertificateDto,
  RunPromotionDto,
  SaveScoresDto,
  UpdateExamDto,
} from './dto/assessment.schema';
import { EligibilityRow, ExamsService, ExamView } from './exams.service';
import {
  CertifiableStudent,
  CertificatePrintPayload,
  CertificateView,
  PromotionPreviewRow,
  PromotionService,
} from './promotion.service';
import {
  ResultsService,
  ScoreGrid,
  ScoreRow,
  TermResultView,
} from './results.service';

@Controller()
export class AssessmentController {
  constructor(
    private readonly exams: ExamsService,
    private readonly results: ResultsService,
    private readonly promotion: PromotionService,
  ) {}

  // §3: "Create & schedule exams" is open to both roles.
  @Get('exams')
  listExams(@Query() query: ListExamsQueryDto): Promise<Page<ExamView>> {
    return this.exams.list(query);
  }

  @Post('exams')
  createExam(
    @Body() dto: CreateExamDto,
    @CurrentActor() actor: Actor,
  ): Promise<ExamView> {
    return this.exams.create(dto, actor);
  }

  @Patch('exams/:id')
  updateExam(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExamDto,
    @CurrentActor() actor: Actor,
  ): Promise<ExamView> {
    return this.exams.update(id, dto, actor);
  }

  // R7 / §4.6 — مستحقو الامتحانات.
  @Post('exams/:id/eligibility/compute')
  computeEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ eligible: number; ineligible: number }> {
    return this.exams.computeEligibility(id, actor);
  }

  @Get('exams/:id/eligibility')
  listEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reasonCode') reasonCode?: string,
  ): Promise<EligibilityRow[]> {
    return this.exams.listEligibility(id, reasonCode);
  }

  @Patch('exam-eligibility/:id')
  @Roles('head_teacher')
  overrideEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OverrideEligibilityDto,
    @CurrentActor() actor: Actor,
  ): Promise<EligibilityRow> {
    return this.exams.overrideEligibility(id, dto, actor);
  }

  @Get('exams/:id/scores')
  getScoreGrid(@Param('id', ParseUUIDPipe) id: string): Promise<ScoreGrid> {
    return this.results.getScoreGrid(id);
  }

  @Post('exams/:id/scores')
  saveScores(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveScoresDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ saved: number }> {
    return this.results.saveScores(id, dto, actor);
  }

  @Post('exams/:id/lock')
  @Roles('head_teacher')
  lock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ isLocked: boolean }> {
    return this.results.setLocked(id, true, actor);
  }

  @Post('exams/:id/unlock')
  @Roles('head_teacher')
  unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ isLocked: boolean }> {
    return this.results.setLocked(id, false, actor);
  }

  // R8: only the head teacher may change a grade after entry, with a reason.
  @Patch('exam-results/:id')
  @Roles('head_teacher')
  correctScore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectScoreDto,
    @CurrentActor() actor: Actor,
  ): Promise<ScoreRow> {
    return this.results.correctScore(id, dto, actor);
  }

  @Post('sections/:sectionId/term-results/:termId/compute')
  computeTermResults(
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Param('termId', ParseIntPipe) termId: number,
    @CurrentActor() actor: Actor,
  ): Promise<TermResultView[]> {
    return this.results.computeTermResults(termId, sectionId, actor, false);
  }

  // §3: "Run promotion / finalise results" is head-teacher only.
  @Post('sections/:sectionId/term-results/:termId/finalize')
  @Roles('head_teacher')
  finalizeTermResults(
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Param('termId', ParseIntPipe) termId: number,
    @CurrentActor() actor: Actor,
  ): Promise<TermResultView[]> {
    return this.results.computeTermResults(termId, sectionId, actor, true);
  }

  @Post('promotion/preview')
  @Roles('head_teacher')
  previewPromotion(
    @Body() dto: RunPromotionDto,
  ): Promise<PromotionPreviewRow[]> {
    return this.promotion.preview(dto);
  }

  @Post('promotion/confirm')
  @Roles('head_teacher')
  confirmPromotion(
    @Body() dto: ConfirmPromotionDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.promotion.confirm(dto, actor);
  }

  // R20: a gate on enrolment, not an automatic promotion.
  @Get('students/:id/comp-eligibility')
  checkCompEligibility(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotion.checkCompEligibility(id);
  }

  @Get('certificates/certifiable')
  @Roles('head_teacher')
  listCertifiable(
    @Query('levelId') levelId?: string,
  ): Promise<CertifiableStudent[]> {
    return this.promotion.listCertifiable(
      levelId ? Number.parseInt(levelId, 10) : undefined,
    );
  }

  @Get('certificates')
  listCertificates(
    @Query('studentId') studentId?: string,
  ): Promise<CertificateView[]> {
    return this.promotion.listCertificates(studentId);
  }

  @Post('certificates')
  @Roles('head_teacher')
  issueCertificate(
    @Body() dto: IssueCertificateDto,
    @CurrentActor() actor: Actor,
  ): Promise<CertificateView> {
    return this.promotion.issueCertificate(dto, actor);
  }

  /**
   * Printing another copy of a certificate the student already holds — a lost
   * or damaged paper. Not an issue: same certificate, same serial, same date.
   *
   * POST rather than GET because it records that a copy exists; the audit log
   * is how the institute answers "how many are out there" later.
   */
  @Post('certificates/:id/reprint')
  @Roles('head_teacher')
  reprintCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<CertificatePrintPayload> {
    return this.promotion.reprintCertificate(id, actor);
  }

  @Post('certificates/:id/revoke')
  @Roles('head_teacher')
  revokeCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeCertificateDto,
    @CurrentActor() actor: Actor,
  ): Promise<CertificateView> {
    return this.promotion.revokeCertificate(id, dto.reason, actor);
  }
}
