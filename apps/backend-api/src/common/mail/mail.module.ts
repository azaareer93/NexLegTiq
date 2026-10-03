import { Global, Module } from '@nestjs/common';

import { MailService } from './mail.service';
import { MailTransport } from './mail-transport';

/**
 * Email for both processes (D-085): `MailService` enqueues (HTTP app), `MailTransport` delivers (used by the worker's
 * EmailProcessor). Templates are rendered in the worker, so the HTTP app never touches SMTP or Resend.
 */
@Global()
@Module({
  providers: [MailService, MailTransport],
  exports: [MailService, MailTransport],
})
export class MailModule {}
