import { Module } from '@nestjs/common';

import { ClientContext } from './client-context';
import { ClientsController } from './clients.controller';
import { ClientsRepository } from './clients.repository';
import { ClientsService } from './clients.service';
import { ContactPersonsService } from './contact-persons.service';

/** Clients and contact persons (MVP-53, D-108). */
@Module({
  controllers: [ClientsController],
  providers: [ClientsService, ContactPersonsService, ClientsRepository, ClientContext],
})
export class ClientsModule {}
