import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { waitForShutdownSignal } from './bootstrap';
import { closeErrorReporting, initErrorReporting } from './common/monitoring/error-reporting';
import { AppConfig } from './config/app-config';
import { WorkerModule } from './worker/worker.module';

// Separate process for BullMQ consumers (D-011). No HTTP server: an application context only.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  initErrorReporting(app.get(AppConfig), 'worker');
  logger.log('Worker started', 'Bootstrap');
  const signal = await waitForShutdownSignal();
  logger.log(`Received ${signal}, shutting down`, 'Bootstrap');
  await app.close();
  await closeErrorReporting();
}

void bootstrap();
