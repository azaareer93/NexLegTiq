import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { waitForShutdownSignal } from './bootstrap';
import { WorkerModule } from './worker/worker.module';

// Separate process for BullMQ consumers (D-011). No HTTP server: an application context only.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  Logger.log('Worker started', 'Bootstrap');
  const signal = await waitForShutdownSignal();
  Logger.log(`Received ${signal}, shutting down`, 'Bootstrap');
  await app.close();
}

void bootstrap();
