import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ImportModule } from './import/import.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { AssessmentModule } from './assessment/assessment.module';
import { AuthModule } from './auth/auth.module';
import { CryptoModule } from './auth/crypto.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { CalendarModule } from './calendar/calendar.module';
import { CommonModule } from './common/common.module';
import { CurriculumModule } from './curriculum/curriculum.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { ReferenceModule } from './reference/reference.module';
import { ReportingModule } from './reporting/reporting.module';
import { SectionsModule } from './sections/sections.module';
import { SettingsModule } from './settings/settings.module';
import { StudentsModule } from './students/students.module';
import { TeachingModule } from './teaching/teaching.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    CryptoModule,
    AuthModule,
    UsersModule,
    ReferenceModule,
    CalendarModule,
    CurriculumModule,
    SettingsModule,
    StudentsModule,
    SectionsModule,
    ImportModule,
    TeachingModule,
    AssessmentModule,
    MessagingModule,
    ReportingModule,
    // §7.7: cron in-process, no Redis and no queue — the idempotency guards
    // live in the database instead (message_campaigns and job_runs).
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: rate-limit before spending CPU on token verification.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Authorization runs last: it needs request.user, which JwtAuthGuard sets.
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}
