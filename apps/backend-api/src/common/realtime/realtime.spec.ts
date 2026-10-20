import type { Namespace, Socket } from 'socket.io';

import { MAX_SOCKETS_PER_USER, RealtimeGateway } from './realtime.gateway';
import { RealtimePublisher } from './realtime.publisher';
import { closeRedis } from './rooms';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { AccessTokenVerifier } from '../../modules/auth/access-token-verifier';
import { AppException } from '../errors/app.exception';

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));
const disconnectSockets = jest.fn();
const inRoom = jest.fn(() => ({ disconnectSockets }));
const emitterClient: { publish?: (channel: string, message: string) => Promise<unknown> } = {};
jest.mock('@socket.io/redis-emitter', () => ({
  Emitter: jest.fn((client: typeof emitterClient) => {
    emitterClient.publish = client.publish;
    return { of: () => ({ to, in: inRoom }) };
  }),
}));

const ID = '01900000-0000-7000-8000-0000000000a1';

describe('RealtimePublisher', () => {
  const warn = jest.fn();
  function publisher(officeId?: string): RealtimePublisher {
    const cls = { get: () => officeId };
    return new RealtimePublisher(
      new AppConfig(parseEnv(testEnv())),
      cls as never,
      { setContext: jest.fn(), warn } as never,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('should emit to user rooms (each once) and to the context office only', () => {
    const p = publisher('office-1');
    p.toUser('u1', 'notification', { notificationId: ID });
    expect(to).toHaveBeenLastCalledWith(['user:u1']);
    p.toUsers(['u1', 'u2', 'u1'], 'task.updated', { taskId: ID, fileId: null });
    expect(to).toHaveBeenLastCalledWith(['user:u1', 'user:u2']);
    p.toOffice('session.scheduled', { sessionId: ID, fileId: ID });
    expect(to).toHaveBeenLastCalledWith(['office:office-1']);
    expect(emit).toHaveBeenLastCalledWith('session.scheduled', { sessionId: ID, fileId: ID });
  });

  it('should refuse an office event without an office and a payload outside the contract', () => {
    expect(() => publisher().toOffice('notification', { notificationId: ID })).toThrow(
      'No office in the context',
    );
    expect(() => publisher('o').toUser('u', 'notification', { notificationId: 'x' })).toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it('should send nothing to nobody, and log instead of throwing when Redis fails', () => {
    const p = publisher('o');
    p.toUsers([], 'notification', { notificationId: ID });
    expect(to).not.toHaveBeenCalled();
    emit.mockImplementationOnce(() => {
      throw new Error('down');
    });
    expect(() => p.toUser('u', 'notification', { notificationId: ID })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'Realtime event not sent');
  });

  it('should log a failed Redis publish instead of leaving an unhandled rejection', async () => {
    const p = publisher('o');
    (p as unknown as { redis: { publish: jest.Mock } }).redis.publish = jest
      .fn()
      .mockRejectedValue(new Error('down'));
    await expect(emitterClient.publish?.('channel', 'message')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'Realtime event not sent');
  });

  it('should close every socket of a deactivated user, logging a failure', () => {
    const p = publisher('o');
    p.disconnectUser('u1');
    expect(inRoom).toHaveBeenCalledWith('user:u1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    disconnectSockets.mockImplementationOnce(() => {
      throw new Error('down');
    });
    expect(() => p.disconnectUser('u1')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'Realtime disconnect not sent');
  });

  it('should close its idle Redis connection on shutdown', async () => {
    await expect(publisher('o').onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('RealtimeGateway', () => {
  type FakeSocket = {
    handshake: { auth: object };
    conn: { readyState: string };
    join: jest.Mock;
    disconnect: jest.Mock;
    once: jest.Mock;
    leave?: () => void;
  };

  function gatewayWith(verify: jest.Mock) {
    const gateway = new RealtimeGateway({ verify } as unknown as AccessTokenVerifier);
    let middleware: (socket: Socket, next: (error?: Error) => void) => void = () => undefined;
    gateway.afterInit({
      use: (fn: typeof middleware) => (middleware = fn),
    } as unknown as Namespace);
    const connect = (auth: object = { token: 't' }, disconnected = false) => {
      const socket: FakeSocket = {
        handshake: { auth },
        conn: { readyState: disconnected ? 'closed' : 'open' },
        join: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        once: jest.fn((_event: string, listener: () => void) => (socket.leave = listener)),
      };
      const result = new Promise<Error | undefined>((resolve) =>
        middleware(socket as unknown as Socket, resolve),
      );
      return { socket, result };
    };
    return connect;
  }

  const valid = () =>
    jest.fn().mockResolvedValue({
      principal: { officeId: 'o1', userId: 'u1' },
      expiresAt: Date.now() + 1000,
    });

  afterEach(() => jest.useRealTimers());

  it('should join the office and user rooms and disconnect when the token expires', async () => {
    jest.useFakeTimers();
    const verify = valid();
    const { socket, result } = gatewayWith(verify)();
    await expect(result).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith('t');
    expect(socket.join).toHaveBeenCalledWith(['office:o1', 'user:u1']);
    jest.advanceTimersByTime(1000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('should drop the expiry timer of a socket that left', async () => {
    jest.useFakeTimers();
    const { socket, result } = gatewayWith(valid())();
    await result;
    socket.leave?.();
    jest.advanceTimersByTime(1000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('should hold nothing for a client that left while its token was checked', async () => {
    const { socket, result } = gatewayWith(valid())({ token: 't' }, true);
    await result;
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.once).not.toHaveBeenCalled();
  });

  it('should cap the sockets of one user and free a place when one leaves', async () => {
    const connect = gatewayWith(valid());
    const open = [];
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i += 1) {
      const attempt = connect();
      await expect(attempt.result).resolves.toBeUndefined();
      open.push(attempt.socket);
    }
    await expect(connect().result).resolves.toMatchObject({ data: { code: 'RATE-001' } });
    open[0]?.leave?.();
    await expect(connect().result).resolves.toBeUndefined();
  });

  it('should refuse with the error code, a missing token and unexpected failures included', async () => {
    const refused = gatewayWith(jest.fn().mockRejectedValue(new AppException('AUTH-002', 'x')))({
      token: 42,
    });
    await expect(refused.result).resolves.toMatchObject({ data: { code: 'AUTH-002' } });
    const broken = gatewayWith(jest.fn().mockRejectedValue(new Error('db down')))();
    await expect(broken.result).resolves.toMatchObject({ data: { code: 'SYS-001' } });
  });
});

describe('closeRedis', () => {
  it('should quit a ready client and drop one that is not', async () => {
    const ready = {
      status: 'ready',
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    await closeRedis(ready as never);
    expect(ready.quit).toHaveBeenCalled();
    const failing = {
      status: 'ready',
      quit: jest.fn().mockRejectedValue(new Error('gone')),
      disconnect: jest.fn(),
    };
    await closeRedis(failing as never);
    expect(failing.disconnect).toHaveBeenCalled();
    const connecting = { status: 'reconnecting', quit: jest.fn(), disconnect: jest.fn() };
    await closeRedis(connecting as never);
    expect(connecting.quit).not.toHaveBeenCalled();
    expect(connecting.disconnect).toHaveBeenCalled();
  });
});
