import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';

import { DependencyUnavailableException } from '../common/errors/app.exception';
import { ApiZodResponse } from '../common/openapi/api-zod.decorators';
import { Public } from '../common/auth/public.decorator';
import { ReadinessRegistry } from './readiness.registry';
import type { ReadinessReport } from './readiness.registry';

const LivenessSchema = z.object({ status: z.literal('ok') });
const ReadinessSchema = z.object({
  status: z.enum(['ok', 'error']),
  checks: z.record(z.string(), z.object({ status: z.enum(['up', 'down']), durationMs: z.number().int() })),
});

/** Outside the /api/v1 prefix: `/health` (liveness) and `/health/ready` (readiness, used by deploys and uptime checks). */
@ApiTags('health')
@Public()
// Probes from the proxy and uptime checks share one IP; they must never be rate limited.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessRegistry) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: the process is up' })
  @ApiZodResponse(200, LivenessSchema)
  liveness(): z.output<typeof LivenessSchema> {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: every registered dependency answers (503 SYS-002 otherwise)' })
  @ApiZodResponse(200, ReadinessSchema)
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.run();
    if (report.status !== 'ok') {
      const details = Object.entries(report.checks)
        .filter(([, check]) => check.status === 'down')
        .map(([name]) => ({ field: name, message: 'unavailable' }));
      throw new DependencyUnavailableException(details);
    }
    return report;
  }
}
