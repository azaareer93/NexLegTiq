import type { Redis } from 'ioredis';

/** Every socket of the office's users joins its office room (D-129). */
export const officeRoom = (officeId: string): string => `office:${officeId}`;

/** A user's own room (user ids are global, and a user belongs to one office). */
export const userRoom = (userId: string): string => `user:${userId}`;

/** Redis channel prefix shared by the socket.io adapter and the emitter (one per deployment, like the queues). */
export const realtimeKey = (prefix: string): string => `${prefix}:socket.io`;

/** Quit a connected client; drop one still connecting (quit would wait for a Redis that may never answer). */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'ready') await client.quit().catch(() => client.disconnect());
  else client.disconnect();
}
