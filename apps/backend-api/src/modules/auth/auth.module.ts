import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccountMailer } from './account-mailer';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginAttemptRepository } from './login-attempt.repository';
import { PasswordHasher } from './password-hasher';
import { PasswordController } from './password.controller';
import { PasswordRepository } from './password.repository';
import { PasswordService } from './password.service';
import { RefreshTokenRepository } from './refresh-token.repository';
import { SignupRepository } from './signup.repository';
import { SignupService } from './signup.service';
import { AppConfig } from '../../config/app-config';

/** Office authentication (MVP-40). JwtAuthGuard is exported for AppModule to register as a global guard. */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ secret: config.auth.jwtSecret }),
    }),
  ],
  controllers: [AuthController, PasswordController],
  providers: [
    AuthService,
    SignupService,
    SignupRepository,
    AccountMailer,
    PasswordService,
    PasswordRepository,
    PasswordHasher,
    JwtAuthGuard,
    RefreshTokenRepository,
    LoginAttemptRepository,
  ],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
