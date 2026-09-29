import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';
import { API_PREFIX, resolveHost, resolvePort } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  const host = resolveHost(process.env['HOST']);
  const port = resolvePort(process.env['PORT']);
  await app.listen(port, host);
  Logger.log(`HTTP API listening on http://${host}:${port}/${API_PREFIX}`, 'Bootstrap');
}

void bootstrap();
