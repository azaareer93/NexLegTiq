import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { REALTIME_NAMESPACE, RealtimePayloadSchemas } from '@nexlegtiq/shared-contracts';
import type { RealtimeEvent, RealtimePayload } from '@nexlegtiq/shared-contracts';
import { Emitter } from '@socket.io/redis-emitter';
import { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { closeRedis, officeRoom, realtimeKey, userRoom } from './rooms';
import { AppConfig } from '../../config/app-config';
import type { RequestContext } from '../context/request-context';
import { redisConnectionOptions } from '../queue/redis-connection';

/**
 * Pushes events to connected apps (D-129) from the API or the worker: through Redis to every API instance's socket.io
 * server (`@socket.io/redis-emitter` + the adapter), so it works whichever process the event comes from. Rooms carry the
 * office (`office:{id}`, `user:{id}` of a user of that office), and payloads are ids only (the app refetches through the
 * API). Best effort: call it after the commit; a Redis failure is logged, never thrown — the data is already saved and
 * the app still sees it on its next fetch.
 */
@Injectable()
export class RealtimePublisher implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly emitter: ReturnType<Emitter['of']>;

  constructor(
    config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RealtimePublisher.name);
    this.redis = new Redis({
      ...redisConnectionOptions(config.redis.url),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (error) => this.logger.warn({ err: error }, 'Realtime Redis error'));
    // The emitter fires `publish` without handling its promise: a Redis outage would be an unhandled rejection (a crash).
    const publisher = {
      publish: (channel: string, message: string) =>
        this.redis
          .publish(channel, message)
          .catch((error: unknown) => this.logger.warn({ err: error }, 'Realtime event not sent')),
    };
    this.emitter = new Emitter(publisher, { key: realtimeKey(config.redis.bullmqPrefix) }).of(
      REALTIME_NAMESPACE,
    );
  }

  /** To one user (any tab or device they have open). */
  toUser<E extends RealtimeEvent>(userId: string, event: E, payload: RealtimePayload<E>): void {
    this.emit([userRoom(userId)], event, payload);
  }

  /** To several users of the current office, each once. */
  toUsers<E extends RealtimeEvent>(
    userIds: readonly string[],
    event: E,
    payload: RealtimePayload<E>,
  ): void {
    this.emit([...new Set(userIds)].map(userRoom), event, payload);
  }

  /** To everyone of the office in the request or job context — never another office (no office → programming error). */
  toOffice<E extends RealtimeEvent>(event: E, payload: RealtimePayload<E>): void {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of a realtime event');
    this.emit([officeRoom(officeId)], event, payload);
  }

  /**
   * Closes every socket of a user on every API instance (deactivation): their reconnect is then refused by the token
   * check, instead of the channel living until the token expires.
   */
  disconnectUser(userId: string): void {
    try {
      this.emitter.in(userRoom(userId)).disconnectSockets(true);
    } catch (error) {
      this.logger.warn({ err: error }, 'Realtime disconnect not sent');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await closeRedis(this.redis);
  }

  private emit(rooms: string[], event: RealtimeEvent, payload: unknown): void {
    // A payload outside the contract is a programming error; it must never reach a client.
    const checked = RealtimePayloadSchemas[event].parse(payload);
    if (rooms.length === 0) return;
    try {
      this.emitter.to(rooms).emit(event, checked);
    } catch (error) {
      this.logger.warn({ err: error, event }, 'Realtime event not sent');
    }
  }
}
