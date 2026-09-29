import { Injectable, SetMetadata, StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiMeta, ApiSuccessResponse } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

import { PaginatedResult } from './paginated-result';

const RAW_RESPONSE = Symbol('RAW_RESPONSE');

/** Opt a handler out of the envelope (e.g. a third-party callback that needs an exact body). Use sparingly. */
export const RawResponse = (): MethodDecorator & ClassDecorator => SetMetadata(RAW_RESPONSE, true);

/** Wraps every successful HTTP response in `{ success, data, meta }` (api-conventions.md#shape). */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(
    private readonly cls: ClsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isRaw = this.reflector.getAllAndOverride<boolean | undefined>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (context.getType() !== 'http' || isRaw) return next.handle();

    return next.handle().pipe(map((value: unknown) => this.wrap(value)));
  }

  private wrap(value: unknown): unknown {
    if (value instanceof StreamableFile) return value;
    const meta: ApiMeta = { timestamp: new Date().toISOString(), requestId: this.cls.getId() };
    if (value instanceof PaginatedResult) {
      return { success: true, data: value.items, meta: { ...meta, pagination: value.pagination } };
    }
    const body: ApiSuccessResponse<unknown> = { success: true, data: value ?? null, meta };
    return body;
  }
}
