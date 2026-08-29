export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface IPasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}
