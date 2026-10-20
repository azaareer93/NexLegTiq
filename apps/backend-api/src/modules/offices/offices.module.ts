import { Module } from '@nestjs/common';

import { OfficesController } from './offices.controller';
import { OfficesService } from './offices.service';

/** The current office's profile and settings (MVP-48, D-125). */
@Module({
  controllers: [OfficesController],
  providers: [OfficesService],
})
export class OfficesModule {}
