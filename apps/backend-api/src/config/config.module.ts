import { Global, Module } from '@nestjs/common';

import { AppConfig } from './app-config';
import { parseEnv } from './env.schema';

@Global()
@Module({
  providers: [
    { provide: AppConfig, useFactory: (): AppConfig => new AppConfig(parseEnv(process.env)) },
  ],
  exports: [AppConfig],
})
export class ConfigModule {}
