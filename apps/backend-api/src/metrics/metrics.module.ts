import { Module } from '@nestjs/common';

import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';

@Module({
  providers: [MetricsService, MetricsServer],
  exports: [MetricsService],
})
export class MetricsModule {}
