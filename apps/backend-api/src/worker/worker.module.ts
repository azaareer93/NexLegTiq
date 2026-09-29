import { Module } from '@nestjs/common';

/** Root module of the worker process. Queue processors are registered here by the queue story (MVP-34). */
@Module({})
export class WorkerModule {}
