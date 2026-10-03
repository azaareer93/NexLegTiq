import type { RedisOptions } from 'bullmq';

/**
 * ioredis options from `REDIS_URL` (`redis://` or `rediss://` for TLS, D-078): user, password and `/<db>` included.
 * BullMQ creates its own connections from these (workers get blocking connections with retries disabled per request).
 */
export function redisConnectionOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(Number.isInteger(db) ? { db } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: { servername: parsed.hostname } } : {}),
  };
}
