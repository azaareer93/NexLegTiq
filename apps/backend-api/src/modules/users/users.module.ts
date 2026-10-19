import { Module } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';

/** The office's people: the directory for pickers now; team management joins with its story (D-123). */
@Module({
  controllers: [UsersController],
  providers: [UsersRepository],
})
export class UsersModule {}
