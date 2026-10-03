import { Global, Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/** Object storage for both processes (D-085); registers the `storage` readiness check (HeadBucket). */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
