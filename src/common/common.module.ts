import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// Global for the same reason PrismaModule is: the audit log is a cross-cutting
// obligation of nearly every mutating service (R8, R9, spec §9), and requiring
// each feature module to import it would be ceremony that someone eventually
// skips.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class CommonModule {}
