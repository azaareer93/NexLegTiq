import { Module } from '@nestjs/common';

import { CoreModule } from '../common/core/core.module';

/** Root module of the HTTP API. */
@Module({
  imports: [CoreModule],
})
export class AppModule {}
