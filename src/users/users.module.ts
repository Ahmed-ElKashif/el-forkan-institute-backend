import { Module } from '@nestjs/common';
import { CryptoModule } from '../auth/crypto.module';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [CryptoModule],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService],
  exports: [UsersRepository],
})
export class UsersModule {}
