import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { TeachingController } from './teaching.controller';
import { TimetableService } from './timetable.service';

// One module for the whole teaching cycle: the timetable produces sessions,
// sessions carry attendance, and all three answer to the same section scope.
@Module({
  controllers: [TeachingController, SessionsController],
  providers: [TimetableService, SessionsService, AttendanceService],
})
export class TeachingModule {}
