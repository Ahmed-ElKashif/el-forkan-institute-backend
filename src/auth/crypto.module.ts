import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PASSWORD_HASHER } from './interfaces/password-hasher.interface';
import { TOKEN_SERVICE } from './interfaces/token.service.interface';
import { BcryptPasswordHasher } from './providers/bcrypt-password-hasher';
import { JwtTokenService } from './providers/jwt-token.service';

// Password hashing and token signing are needed by AuthModule (login) and by
// UsersModule (creating a teacher's initial password), and the global
// JwtAuthGuard in AppModule needs the token service too. Binding them here
// rather than in AuthModule is what keeps UsersModule from having to import
// AuthModule, which already imports UsersModule — a cycle that would otherwise
// need forwardRef().
@Module({
  imports: [JwtModule.register({})],
  providers: [
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
  ],
  exports: [PASSWORD_HASHER, TOKEN_SERVICE],
})
export class CryptoModule {}
