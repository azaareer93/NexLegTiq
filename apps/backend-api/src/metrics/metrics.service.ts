import type { ServerResponse } from 'node:http';

import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

import { routeTemplateOf } from '../common/http/route-template';
import type { RoutedRequest } from '../common/http/route-template';

/** Prometheus metrics for the HTTP API: Node process defaults + request duration by route template. */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * Express middleware. Records once when the connection closes (completed or aborted). Labels use the matched route
   * template, never raw URLs, to bound cardinality.
   */
  readonly middleware = (req: RoutedRequest, res: ServerResponse, next: () => void): void => {
    const stop = this.httpDuration.startTimer();
    res.once('close', () => {
      const template = routeTemplateOf(req) ?? 'unmatched';
      stop({
        method: req.method ?? 'UNKNOWN',
        route: template,
        status_code: String(res.statusCode),
      });
    });
    next();
  };

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
