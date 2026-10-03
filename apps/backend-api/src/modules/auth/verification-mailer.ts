import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export interface VerificationEmail {
  readonly userId: string;
  readonly officeId: string;
  readonly email: string;
  readonly language: 'AR' | 'EN';
  /** Raw link token; only its SHA-256 is stored. Never log it. */
  readonly token: string;
}

/**
 * Hands the signup verification link to email delivery, after the signup transaction has committed (D-083).
 * ponytail: the email queue and bilingual templates arrive with the storage & email adapter story; until then the link is
 * created but not sent, and this logs that it was skipped (without the token).
 */
@Injectable()
export class VerificationMailer {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(VerificationMailer.name);
  }

  send(email: VerificationEmail): void {
    this.logger.warn({ userId: email.userId, officeId: email.officeId }, 'Verification email not sent: email delivery is not wired yet');
  }
}
