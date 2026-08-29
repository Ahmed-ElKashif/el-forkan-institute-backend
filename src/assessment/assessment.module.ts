import { Module } from '@nestjs/common';
import { AssessmentController } from './assessment.controller';
import { ExamsService } from './exams.service';
import { PromotionService } from './promotion.service';
import { ResultsService } from './results.service';

// One module for the whole assessment cycle: exams produce eligibility,
// eligibility drives the score grid, scores drive term results, and term
// results drive promotion and certification. Splitting them would mean the
// same curriculum/level lookups in four places.
@Module({
  controllers: [AssessmentController],
  providers: [ExamsService, ResultsService, PromotionService],
})
export class AssessmentModule {}
