import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { TeachingController } from './teaching.controller';

// One module for the whole teaching cycle: class days produce sessions, sessions
// carry attendance, and both answer to the same section scope.
@Module({
  controllers: [TeachingController, SessionsController],
  providers: [SessionsService, AttendanceService],
})
export class TeachingModule {}
