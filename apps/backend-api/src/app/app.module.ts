import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { CoreModule } from '../common/core/core.module';
import { GlobalExceptionFilter } from '../common/errors/global-exception.filter';
import { EnvelopeInterceptor } from '../common/http/envelope.interceptor';

/** Root module of the HTTP API. */
@Module({
  imports: [CoreModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
