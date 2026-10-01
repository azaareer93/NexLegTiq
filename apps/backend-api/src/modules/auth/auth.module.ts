import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AppConfig } from '../../config/app-config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginAttemptRepository } from './login-attempt.repository';
import { PasswordHasher } from './password-hasher';
import { RefreshTokenRepository } from './refresh-token.repository';
import { SignupService } from './signup.service';
import { VerificationMailer } from './verification-mailer';

/** Office authentication (MVP-40). JwtAuthGuard is exported for AppModule to register as a global guard. */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ secret: config.auth.jwtSecret }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SignupService,
    VerificationMailer,
    PasswordHasher,
    JwtAuthGuard,
    RefreshTokenRepository,
    LoginAttemptRepository,
  ],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
