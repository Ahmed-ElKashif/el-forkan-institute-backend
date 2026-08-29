import { Injectable } from '@nestjs/common';
import { Prisma, users as UserRecord } from '@prisma/client';
import { branchScope } from '../common/branch-scope';
import { PageQuery, toPrismaPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { ListUsersQueryDto } from './dto/user.schema';

export interface UserListFilter extends ListUsersQueryDto {
  actorBranchId: number | null;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByUsername(username: string) {
    return this.prisma.users.findUnique({ where: { username } });
  }

  findById(id: string) {
    return this.prisma.users.findUnique({ where: { id } });
  }

  // Scoping lives here, not in the service or controller (spec §9): a caller
  // cannot forget to apply it, because there is no unscoped list method.
  async list(
    filter: UserListFilter,
  ): Promise<{ rows: UserRecord[]; total: number }> {
    const where = buildWhere(filter);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.users.findMany({
        where,
        orderBy: { full_name: 'asc' },
        ...toPrismaPage(filter as PageQuery),
      }),
      this.prisma.users.count({ where }),
    ]);
    return { rows, total };
  }

  create(data: Prisma.usersCreateInput) {
    return this.prisma.users.create({ data });
  }

  update(id: string, data: Prisma.usersUpdateInput) {
    return this.prisma.users.update({ where: { id }, data });
  }

  softDelete(id: string, deletedBy: string, reason: string) {
    return this.prisma.users.update({
      where: { id },
      data: {
        deleted_at: new Date(),
        deleted_by: deletedBy,
        delete_reason: reason,
        is_active: false,
      },
    });
  }
}

function buildWhere(filter: UserListFilter): Prisma.usersWhereInput {
  return {
    deleted_at: null,
    ...branchScope(filter.actorBranchId),
    ...(filter.role ? { role: filter.role } : {}),
    ...(filter.gender ? { gender: filter.gender } : {}),
    ...(filter.includeInactive ? {} : { is_active: true }),
    ...(filter.search
      ? {
          OR: [
            { full_name: { contains: filter.search, mode: 'insensitive' } },
            { username: { contains: filter.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}
