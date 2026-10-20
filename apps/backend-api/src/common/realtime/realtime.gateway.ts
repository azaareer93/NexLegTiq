import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayInit } from '@nestjs/websockets';
import { REALTIME_NAMESPACE } from '@nexlegtiq/shared-contracts';
import type { Namespace, Socket } from 'socket.io';

import { officeRoom, userRoom } from './rooms';
import { AccessTokenVerifier } from '../../modules/auth/access-token-verifier';
import { AppException } from '../errors/app.exception';

/** Open sockets per user on one API instance: tabs and devices, with room to spare; more is a flood. */
export const MAX_SOCKETS_PER_USER = 10;

/**
 * The office realm's realtime gateway (`/ws`, D-129). A connection must bring the same access token as the HTTP API
 * (`handshake.auth.token`); it is checked like a request (`AccessTokenVerifier`: user and office active) and refused with
 * the error code as `connect_error` (AUTH-002 expired → the app refreshes and reconnects; RATE-001 past the per-user
 * cap). The socket joins its office and user rooms and is disconnected when its token expires, so a revoked or demoted
 * user never keeps a live channel longer than one token. Read-only: clients cannot send anything.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit<Namespace> {
  private readonly perUser = new Map<string, number>();

  constructor(private readonly tokens: AccessTokenVerifier) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.admit(socket).then(
        () => next(),
        (error: unknown) => {
          const code = error instanceof AppException ? error.code : 'SYS-001';
          next(Object.assign(new Error(code), { data: { code } }));
        },
      );
    });
  }

  private async admit(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown };
    const token = typeof auth.token === 'string' ? auth.token : undefined;
    const { principal, expiresAt } = await this.tokens.verify(token);
    const { userId } = principal;
    const open = this.perUser.get(userId) ?? 0;
    if (open >= MAX_SOCKETS_PER_USER) throw new AppException('RATE-001', 'Too many connections');
    // The client may have gone while the token was checked: nothing to hold. (`socket.connected` is still false here.)
    if (socket.conn.readyState !== 'open') return;
    this.perUser.set(userId, open + 1);
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(expiresAt - Date.now(), 0));
    expiry.unref();
    socket.once('disconnect', () => {
      clearTimeout(expiry);
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left > 0) this.perUser.set(userId, left);
      else this.perUser.delete(userId);
    });
    await socket.join([officeRoom(principal.officeId), userRoom(userId)]);
  }
}
