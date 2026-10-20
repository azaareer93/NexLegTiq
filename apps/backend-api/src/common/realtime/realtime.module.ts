import { Global, Module } from '@nestjs/common';

import { RealtimeGateway } from './realtime.gateway';
import { RealtimePublisher } from './realtime.publisher';
import { AuthModule } from '../../modules/auth/auth.module';

/** The publisher, for every module of the API and the worker (D-129). */
@Global()
@Module({ providers: [RealtimePublisher], exports: [RealtimePublisher] })
export class RealtimeModule {}

/** The socket.io gateway: the API process only (the worker publishes, never listens). */
@Module({ imports: [AuthModule], providers: [RealtimeGateway] })
export class RealtimeGatewayModule {}
