import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { IPasswordHasher } from '../interfaces/password-hasher.interface';

const BCRYPT_COST = 12;

@Injectable()
export class BcryptPasswordHasher implements IPasswordHasher {
  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_COST);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
