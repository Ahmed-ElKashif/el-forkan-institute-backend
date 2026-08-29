import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CryptoModule } from './crypto.module';
import { doubleCsrfProtection } from './csrf';

@Module({
  imports: [CryptoModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService],
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
