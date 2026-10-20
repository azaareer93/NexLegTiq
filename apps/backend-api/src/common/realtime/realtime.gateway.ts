import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { REALTIME_NAMESPACE } from '@nexlegtiq/shared-contracts';
import type { Namespace, Socket } from 'socket.io';

import { officeRoom, userRoom } from './rooms';
import { AccessTokenVerifier } from '../../modules/auth/access-token-verifier';
import { AppException } from '../errors/app.exception';

/** Node's timers take at most ~24.8 days; an access token lives 15 minutes (D-082). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The office realm's realtime gateway (`/ws`, D-129). A connection must bring the same access token as the HTTP API
 * (`handshake.auth.token`); it is checked like a request (`AccessTokenVerifier`: user and office active) and refused with
 * the error code as `connect_error` (AUTH-002 expired → the app refreshes and reconnects). The socket joins its office
 * and user rooms and is disconnected when its token expires, so a revoked or demoted user never keeps a live channel
 * longer than one token. Read-only: clients cannot send anything.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit<Namespace>, OnGatewayDisconnect<Socket> {
  private readonly expiries = new Map<string, NodeJS.Timeout>();

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

  handleDisconnect(socket: Socket): void {
    clearTimeout(this.expiries.get(socket.id));
    this.expiries.delete(socket.id);
  }

  private async admit(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown };
    const token = typeof auth.token === 'string' ? auth.token : undefined;
    const { principal, expiresAt } = await this.tokens.verify(token);
    await socket.join([officeRoom(principal.officeId), userRoom(principal.userId)]);
    const left = Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_MS);
    this.expiries.set(
      socket.id,
      setTimeout(() => socket.disconnect(true), left),
    );
  }
}
