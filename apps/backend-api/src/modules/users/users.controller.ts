import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DirectoryUserSchema } from '@nexlegtiq/shared-contracts';
import type { DirectoryUser } from '@nexlegtiq/shared-contracts';

import { UsersRepository } from './users.repository';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

/** The office's people (api-conventions.md#users). Team management (list with emails, roles, invitations) is its own story. */
@ApiTags('users')
@ApiBearerAuth('JWT')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersRepository) {}

  /** Every staff member works with colleagues' names (D-123): any role that sees files may read the directory. */
  @Get('directory')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'Active colleagues (name and role) for pickers, by name' })
  @ApiZodResponse(HttpStatus.OK, DirectoryUserSchema.array())
  directory(): Promise<DirectoryUser[]> {
    return this.users.directory();
  }
}
