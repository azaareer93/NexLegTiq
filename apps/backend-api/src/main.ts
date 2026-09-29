import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app/app.module';
import { API_PREFIX } from './bootstrap';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  const { host, port } = app.get(AppConfig).http;
  await app.listen(port, host);
  app.get(Logger).log(`HTTP API listening on http://${host}:${port}/${API_PREFIX}`, 'Bootstrap');
}

void bootstrap();
