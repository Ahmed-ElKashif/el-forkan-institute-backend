import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { CryptoModule } from './crypto.module';
import { doubleCsrfProtection } from './csrf';
import { EMAIL_SENDER } from './interfaces/email-sender.interface';
import { ResendEmailSender } from './providers/resend-email-sender';

@Module({
  imports: [CryptoModule, UsersModule],
  controllers: [AuthController],
  // EMAIL_SENDER is bound here rather than in CryptoModule: it is a login-only
  // seam (the OTP), not the cross-cutting crypto that UsersModule also needs.
  providers: [
    AuthService,
    OtpService,
    { provide: EMAIL_SENDER, useClass: ResendEmailSender },
  ],
})
export class AuthModule implements NestModule {
  // /auth/refresh is the only cookie-authenticated route, so it's the only
  // CSRF surface (spec §7.3) — scoped here rather than applied globally.
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(doubleCsrfProtection)
      .forRoutes({ path: 'auth/refresh', method: RequestMethod.POST });
  }
}
