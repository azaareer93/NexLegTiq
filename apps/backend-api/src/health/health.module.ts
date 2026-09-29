import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** HTTP-only probes. ReadinessRegistry itself lives in CoreModule so the worker's infra modules can register too. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
