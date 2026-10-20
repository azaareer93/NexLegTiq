import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

import { closeRedis, realtimeKey } from './rooms';
import { AppConfig } from '../../config/app-config';
import { redisConnectionOptions } from '../queue/redis-connection';

/**
 * socket.io over Redis (D-129): every API instance shares rooms, and the worker's emitter reaches them. CORS follows the
 * HTTP API's allow-list (the SPAs connect cross-origin with credentials).
 */
class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(
    app: INestApplication,
    private readonly config: AppConfig,
  ) {
    super(app);
    this.pub = new Redis({ ...redisConnectionOptions(config.redis.url), lazyConnect: true });
    // The adapter subscribes without handling the promise: the subscriber waits for Redis instead of failing a retry count.
    this.sub = this.pub.duplicate({ maxRetriesPerRequest: null });
    for (const client of [this.pub, this.sub]) {
      // An unhandled ioredis error event would crash the process; the clients reconnect on their own.
      client.on('error', (error: Error) => this.log.warn(`Realtime Redis error: ${error.message}`));
    }
  }

  /** Connects before the server exists; Redis down at boot is logged and retried, never fatal (D-084). */
  async connect(): Promise<void> {
    await Promise.all([this.pub.connect(), this.sub.connect()]).catch((error: Error) =>
      this.log.warn(`Realtime Redis unavailable at boot: ${error.message}`),
    );
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: [...this.config.corsOrigins] },
      // WebSocket only: long polling would need sticky sessions across API instances.
      transports: ['websocket'],
    }) as Server;
    // socket.io always serves the root namespace; nothing lives there, so refuse it rather than hold idle sockets open.
    server.of('/').use((_socket, next) => next(new Error('AUTH-003')));
    server.adapter(
      createAdapter(this.pub, this.sub, { key: realtimeKey(this.config.redis.bullmqPrefix) }),
    );
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all([closeRedis(this.pub), closeRedis(this.sub)]);
  }
}

/**
 * Puts the realtime gateway on Redis. Called by `main.ts` (and tests that need it) after `configureApp`: an app built
 * without it (unit tests) serves socket.io in memory and never contacts Redis.
 */
export async function useRealtimeAdapter(app: INestApplication): Promise<void> {
  const adapter = new RedisIoAdapter(app, app.get(AppConfig));
  await adapter.connect();
  app.useWebSocketAdapter(adapter);
}
