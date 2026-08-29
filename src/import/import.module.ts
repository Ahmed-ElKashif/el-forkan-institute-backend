import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

// Import and export share a module because they share the file format: the
// export writes the exact layout the import reads (§6.1/§6.5), and an exported
// roster must survive being corrected in Excel and imported back.
@Module({
  controllers: [ImportController, ExportController],
  providers: [ImportService, ExportService],
})
export class ImportModule {}
