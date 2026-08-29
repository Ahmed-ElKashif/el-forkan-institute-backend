import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';

// The database is the authority on uniqueness, foreign keys and the composite
// FKs that enforce gender segregation (spec §5.1), so violations arrive here
// as driver errors rather than as application-level checks. Translating them
// once means no service has to pre-query "does this already exist" — which
// would be both slower and racy.
const STATUS_BY_PRISMA_CODE: Record<string, HttpStatus> = {
  P2002: HttpStatus.CONFLICT, // unique constraint
  P2003: HttpStatus.CONFLICT, // foreign key constraint
  P2025: HttpStatus.NOT_FOUND, // record required but not found
};

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const status = STATUS_BY_PRISMA_CODE[exception.code];
    if (status === undefined) {
      // An unmapped driver error is a bug, not a client mistake: let the
      // default filter log it and return 500 rather than inventing a 4xx.
      super.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    response.status(status).json({
      statusCode: status,
      error: HttpStatus[status],
      message: describe(exception),
    });
  }
}

function describe(exception: Prisma.PrismaClientKnownRequestError): string {
  const target = exception.meta?.target;
  switch (exception.code) {
    case 'P2002':
      return Array.isArray(target)
        ? `Already exists: ${target.join(', ')}`
        : 'Already exists';
    case 'P2003':
      // Covers both "referenced row is missing" and the composite-FK gender
      // guards, which is why the message names neither specifically.
      return 'Referenced record is missing or not allowed in this combination';
    default:
      return 'Record not found';
  }
}
