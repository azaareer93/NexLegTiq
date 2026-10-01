import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { AppConfig } from '../../config/app-config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordHasher } from './password-hasher';

/**
 * Office authentication (MVP-40). JwtAuthGuard is exported for AppModule to register as the first APP_GUARD.
 * ponytail: the throttler keeps counters in process memory — fine for one API container (D-020); switch to Redis
 * storage once the queue story wires Redis, or as soon as a second API instance runs.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ secret: config.auth.jwtSecret }),
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordHasher, JwtAuthGuard],
  exports: [JwtAuthGuard, PasswordHasher],
})
export class AuthModule {}
