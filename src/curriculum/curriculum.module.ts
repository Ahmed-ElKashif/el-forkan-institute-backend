import { Module } from '@nestjs/common';
import { CurriculumController } from './curriculum.controller';
import { CurriculumService } from './curriculum.service';

@Module({
  controllers: [CurriculumController],
  providers: [CurriculumService],
})
export class CurriculumModule {}
