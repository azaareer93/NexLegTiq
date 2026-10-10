import { Module } from '@nestjs/common';

import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';
import { ProsecutorsController } from './prosecutors.controller';
import { ProsecutorsService } from './prosecutors.service';
import { ReferenceContext } from './reference-context';

/** Courts, judges and public prosecutors (MVP-66, D-115). */
@Module({
  controllers: [CourtsController, ProsecutorsController],
  providers: [CourtsService, ProsecutorsService, ReferenceContext],
})
export class CourtsModule {}
