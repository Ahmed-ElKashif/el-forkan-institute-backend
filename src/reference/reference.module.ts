import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { GeographyController } from './geography.controller';
import { GeographyService } from './geography.service';

// One module because there is one actor behind all of it: the head teacher
// maintaining reference data (spec §3). Two controllers because the two
// halves have no shared rules — geography is where people are, the catalogue
// is what gets taught.
@Module({
  controllers: [GeographyController, CatalogueController],
  providers: [GeographyService, CatalogueService],
})
export class ReferenceModule {}
