import { Module } from '@nestjs/common';

import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';
import { QueueMetrics } from './queue-metrics';

@Module({
  providers: [MetricsService, MetricsServer, QueueMetrics],
  exports: [MetricsService],
})
export class MetricsModule {}
