import { Module } from '@nestjs/common';

import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';
import { QueueMetrics } from './queue-metrics';
import { ErrorReportingShutdown } from '../common/monitoring/error-reporting';

/** Monitoring of the HTTP API process: /metrics and the error reporter's flush at shutdown (D-230). */
@Module({
  providers: [MetricsService, MetricsServer, QueueMetrics, ErrorReportingShutdown],
  exports: [MetricsService],
})
export class MetricsModule {}
