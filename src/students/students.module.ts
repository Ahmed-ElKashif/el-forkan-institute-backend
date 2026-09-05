import { Module } from '@nestjs/common';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { StudentRecordsService } from './student-records.service';

@Module({
  controllers: [StudentsController],
  providers: [StudentsService, StudentRecordsService],
  exports: [StudentsService],
})
export class StudentsModule {}
