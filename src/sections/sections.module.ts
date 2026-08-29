import { Module } from '@nestjs/common';
import { EnrollmentsController } from './enrollments.controller';
import { SectionsController } from './sections.controller';
import { SectionsService } from './sections.service';

// Sections and enrollments share a module because an enrollment is a student's
// place *in a section*: the same scoping rule governs both, and splitting them
// would mean two copies of it.
@Module({
  controllers: [SectionsController, EnrollmentsController],
  providers: [SectionsService],
  exports: [SectionsService],
})
export class SectionsModule {}
