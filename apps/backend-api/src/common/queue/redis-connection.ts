import type { RedisOptions } from 'bullmq';

/**
 * ioredis options from `REDIS_URL` (`redis://` or `rediss://` for TLS, D-078): user, password and `/<db>` included.
 * BullMQ creates its own connections from these (workers get blocking connections with retries disabled per request).
 * A non-numeric `/db` path is a configuration error and fails the boot.
 */
export function redisConnectionOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\//, '');
  if (!/^\d*$/.test(path))
    throw new Error('REDIS_URL database must be a number (redis://host:6379/0)');
  // URL keeps the brackets of an IPv6 literal; ioredis wants the bare address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return {
    host,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    db: path ? Number(path) : 0,
    ...(parsed.protocol === 'rediss:' ? { tls: { servername: host } } : {}),
  };
}
