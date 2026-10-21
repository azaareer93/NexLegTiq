import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { redisConnectionOptions } from '../../common/queue/redis-connection';
import { closeRedis } from '../../common/realtime/rooms';
import { CacheKeys } from '../../common/tenancy/tenant-keys';
import { AppConfig } from '../../config/app-config';

/**
 * AI answers cached in Redis under `o:{officeId}:ai:…` (D-058, ai-ocr.md). Best effort: a Redis failure is a miss on
 * read and is skipped on write — AI still answers, it just costs a call.
 */
@Injectable()
export class AiCache implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiCache.name);
    this.redis = new Redis({
      ...redisConnectionOptions(config.redis.url),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      keyPrefix: `${config.redis.bullmqPrefix}:`,
    });
    this.redis.on('error', (error) => this.logger.warn({ err: error }, 'AI cache Redis error'));
  }

  async get<T>(officeId: OfficeId, parts: readonly string[]): Promise<T | null> {
    try {
      const hit = await this.redis.get(CacheKeys.tenant(officeId, 'ai', ...parts));
      return hit === null ? null : (JSON.parse(hit) as T);
    } catch (error) {
      this.logger.warn({ err: error }, 'AI cache read failed');
      return null;
    }
  }

  async set(
    officeId: OfficeId,
    parts: readonly string[],
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(
        CacheKeys.tenant(officeId, 'ai', ...parts),
        JSON.stringify(value),
        'EX',
        ttlSeconds,
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'AI cache write failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await closeRedis(this.redis);
  }
}
