import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
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
  OverridePromotionDto,
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
  listExams(
    @Query() query: ListExamsQueryDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<Page<ExamView>> {
    return this.exams.list(query, viewer);
  }

  @Post('exams')
  createExam(
    @Body() dto: CreateExamDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ExamView> {
    return this.exams.create(dto, actor, viewer);
  }

  @Patch('exams/:id')
  updateExam(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExamDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ExamView> {
    return this.exams.update(id, dto, actor, viewer);
  }

  // R7 / §4.6 — مستحقو الامتحانات.
  @Post('exams/:id/eligibility/compute')
  computeEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ eligible: number; ineligible: number }> {
    return this.exams.computeEligibility(id, actor, viewer);
  }

  @Get('exams/:id/eligibility')
  listEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
    @Query('reasonCode') reasonCode?: string,
  ): Promise<EligibilityRow[]> {
    return this.exams.listEligibility(id, viewer, reasonCode);
  }

  @Patch('exam-eligibility/:id')
  @Roles('head_teacher')
  overrideEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OverrideEligibilityDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<EligibilityRow> {
    return this.exams.overrideEligibility(id, dto, actor, viewer);
  }

  @Get('exams/:id/scores')
  getScoreGrid(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ScoreGrid> {
    return this.results.getScoreGrid(id, viewer);
  }

  @Post('exams/:id/scores')
  saveScores(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveScoresDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ saved: number }> {
    return this.results.saveScores(id, dto, actor, viewer);
  }

  @Post('exams/:id/lock')
  @Roles('head_teacher')
  lock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ isLocked: boolean }> {
    return this.results.setLocked(id, true, actor, viewer);
  }

  @Post('exams/:id/unlock')
  @Roles('head_teacher')
  unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<{ isLocked: boolean }> {
    return this.results.setLocked(id, false, actor, viewer);
  }

  // R8: only the head teacher may change a grade after entry, with a reason.
  @Patch('exam-results/:id')
  @Roles('head_teacher')
  correctScore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectScoreDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<ScoreRow> {
    return this.results.correctScore(id, dto, actor, viewer);
  }

  @Post('sections/:sectionId/term-results/:termId/compute')
  computeTermResults(
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Param('termId', ParseIntPipe) termId: number,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<TermResultView[]> {
    return this.results.computeTermResults(
      termId,
      sectionId,
      actor,
      false,
      viewer,
    );
  }

  // §3: "Run promotion / finalise results" is head-teacher only.
  @Post('sections/:sectionId/term-results/:termId/finalize')
  @Roles('head_teacher')
  finalizeTermResults(
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Param('termId', ParseIntPipe) termId: number,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<TermResultView[]> {
    return this.results.computeTermResults(
      termId,
      sectionId,
      actor,
      true,
      viewer,
    );
  }

  /* The promotion run is open to both roles, scoped rather than restricted: a
     teacher previews, edits and confirms their own classes, a head teacher the
     whole branch. There is no `@Roles` here because the boundary is data, not
     rank — `sectionScope` in `preview` decides what anyone can see, and
     `confirm` replays that same preview, so an enrolment a caller cannot reach
     is never in the run they are confirming. */
  @Post('promotion/preview')
  previewPromotion(
    @Body() dto: RunPromotionDto,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<PromotionPreviewRow[]> {
    return this.promotion.preview(dto, viewer);
  }

  @Post('promotion/confirm')
  confirmPromotion(
    @Body() dto: ConfirmPromotionDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ) {
    return this.promotion.confirm(dto, actor, viewer);
  }

  /* Recording a disagreement with the engine (§4.3). PUT, so replaying it is a
     no-op rather than stacking overrides on one enrolment. */
  @Put('promotion/overrides/:enrollmentId')
  overridePromotionDecision(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Body() dto: OverridePromotionDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ) {
    return this.promotion.setDecisionOverride(enrollmentId, dto, actor, viewer);
  }

  @Delete('promotion/overrides/:enrollmentId')
  clearPromotionDecision(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Query('afterMakeup') afterMakeup: string | undefined,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ) {
    return this.promotion.clearDecisionOverride(
      enrollmentId,
      afterMakeup === 'true',
      actor,
      viewer,
    );
  }

  // R20: a gate on enrolment, not an automatic promotion.
  @Get('students/:id/comp-eligibility')
  checkCompEligibility(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer: AuthenticatedUser,
  ) {
    return this.promotion.checkCompEligibility(id, viewer);
  }

  @Get('certificates/certifiable')
  @Roles('head_teacher')
  listCertifiable(
    @CurrentUser() viewer: AuthenticatedUser,
    @Query('levelId') levelId?: string,
  ): Promise<CertifiableStudent[]> {
    return this.promotion.listCertifiable(
      viewer,
      levelId ? Number.parseInt(levelId, 10) : undefined,
    );
  }

  @Get('certificates')
  listCertificates(
    @CurrentUser() viewer: AuthenticatedUser,
    @Query('studentId') studentId?: string,
  ): Promise<CertificateView[]> {
    return this.promotion.listCertificates(viewer, studentId);
  }

  @Post('certificates')
  @Roles('head_teacher')
  issueCertificate(
    @Body() dto: IssueCertificateDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<CertificateView> {
    return this.promotion.issueCertificate(dto, actor, viewer);
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
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<CertificatePrintPayload> {
    return this.promotion.reprintCertificate(id, actor, viewer);
  }

  @Post('certificates/:id/revoke')
  @Roles('head_teacher')
  revokeCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeCertificateDto,
    @CurrentActor() actor: Actor,
    @CurrentUser() viewer: AuthenticatedUser,
  ): Promise<CertificateView> {
    return this.promotion.revokeCertificate(id, dto.reason, actor, viewer);
  }
}
