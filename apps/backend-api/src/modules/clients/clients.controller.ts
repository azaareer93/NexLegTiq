import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ClientListItemSchema,
  ClientQuerySchema,
  ClientSchema,
  ContactPersonSchema,
  CreateClientSchema,
  CreateContactPersonSchema,
  UpdateClientSchema,
  UpdateContactPersonSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Client,
  ClientListItem,
  ClientQuery,
  ContactPerson,
  CreateClientRequest,
  CreateContactPersonRequest,
  UpdateClientRequest,
  UpdateContactPersonRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { ClientsService } from './clients.service';
import { ContactPersonsService } from './contact-persons.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Clients and their contact persons (api-conventions.md#clients, MVP-53, D-108). Every route needs `manage:clients`. */
@ApiTags('clients')
@ApiBearerAuth('JWT')
@RequirePermissions('manage:clients')
@Controller('clients')
export class ClientsController {
  constructor(
    private readonly clients: ClientsService,
    private readonly contacts: ContactPersonsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a client' })
  @ApiZodBody(CreateClientSchema)
  @ApiZodResponse(HttpStatus.CREATED, ClientSchema)
  create(
    @Body(new ZodValidationPipe(CreateClientSchema)) body: CreateClientRequest,
    @Req() req: Request,
  ): Promise<Client> {
    return this.clients.create(body, this.caller(req));
  }

  @Get()
  @ApiOperation({
    summary: 'List live clients (search, filters, sort by name, creation or open files)',
  })
  @ApiZodQuery(ClientQuerySchema)
  @ApiZodResponse(HttpStatus.OK, ClientListItemSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(ClientQuerySchema)) query: ClientQuery,
  ): Promise<PaginatedResult<ClientListItem>> {
    return this.clients.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A client with its contacts and file counts' })
  @ApiZodResponse(HttpStatus.OK, ClientSchema)
  get(@Param('id', uuid()) id: string): Promise<Client> {
    return this.clients.get(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a client' })
  @ApiZodBody(UpdateClientSchema)
  @ApiZodResponse(HttpStatus.OK, ClientSchema)
  update(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdateClientSchema)) body: UpdateClientRequest,
    @Req() req: Request,
  ): Promise<Client> {
    return this.clients.update(id, body, this.caller(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a client (422 BIZ-010 while it has open files)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  remove(@Param('id', uuid()) id: string, @Req() req: Request): Promise<void> {
    return this.clients.remove(id, this.caller(req));
  }

  @Get(':id/contacts')
  @ApiOperation({ summary: "A client's contact persons, primary first" })
  @ApiZodResponse(HttpStatus.OK, z.array(ContactPersonSchema))
  listContacts(@Param('id', uuid()) id: string): Promise<ContactPerson[]> {
    return this.contacts.list(id);
  }

  @Post(':id/contacts')
  @ApiOperation({ summary: 'Add a contact person (the first one is primary)' })
  @ApiZodBody(CreateContactPersonSchema)
  @ApiZodResponse(HttpStatus.CREATED, ContactPersonSchema)
  createContact(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(CreateContactPersonSchema)) body: CreateContactPersonRequest,
    @Req() req: Request,
  ): Promise<ContactPerson> {
    return this.contacts.create(id, body, this.caller(req));
  }

  @Patch(':id/contacts/:contactId')
  @ApiOperation({ summary: 'Edit a contact person or make it the primary one' })
  @ApiZodBody(UpdateContactPersonSchema)
  @ApiZodResponse(HttpStatus.OK, ContactPersonSchema)
  updateContact(
    @Param('id', uuid()) id: string,
    @Param('contactId', uuid()) contactId: string,
    @Body(new ZodValidationPipe(UpdateContactPersonSchema)) body: UpdateContactPersonRequest,
    @Req() req: Request,
  ): Promise<ContactPerson> {
    return this.contacts.update(id, contactId, body, this.caller(req));
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a contact person (the oldest remaining one becomes primary)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  removeContact(
    @Param('id', uuid()) id: string,
    @Param('contactId', uuid()) contactId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.contacts.remove(id, contactId, this.caller(req));
  }

  private caller(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
