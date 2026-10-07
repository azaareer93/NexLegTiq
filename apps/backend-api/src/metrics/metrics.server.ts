import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { MetricsService } from './metrics.service';
import { AppConfig } from '../config/app-config';

/**
 * Serves `GET /metrics` on its own port (METRICS_HOST:METRICS_PORT), separate from the public API so it is only
 * reachable on the internal network.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | undefined;

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetricsServer.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const { enabled, host, port } = this.config.metrics;
    if (!enabled) return;
    const address = await this.start(host, port);
    this.logger.info(`Metrics on http://${address.address}:${address.port}/metrics`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(host: string, port: number): Promise<AddressInfo> {
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.metrics.render().then(
        (body) =>
          res.writeHead(200, { 'content-type': this.metrics.registry.contentType }).end(body),
        () => res.writeHead(500).end(),
      );
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address() as AddressInfo));
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
