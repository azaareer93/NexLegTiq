import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app/app.module';
import { configureApp } from './app/configure-app';
import { API_PREFIX } from './bootstrap';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  const { host, port } = app.get(AppConfig).http;
  await app.listen(port, host);
  app.get(Logger).log(`HTTP API listening on http://${host}:${port}/${API_PREFIX}`, 'Bootstrap');
}

void bootstrap();
