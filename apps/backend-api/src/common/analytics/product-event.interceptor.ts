import { Injectable, SetMetadata } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProductEventType } from '@nexlegtiq/shared-types';
import { from, mergeMap } from 'rxjs';
import type { Observable } from 'rxjs';

import { ProductAnalytics } from './product-analytics';

/** Events a route records with no props; FIRST_CASE_CREATED works out its own (D-215). */
type RouteEvent = Exclude<ProductEventType, 'ONBOARDING_STEP_COMPLETED'>;

const PRODUCT_EVENT_KEY = 'nlq:product-event';

/** Records `event` for the caller's office once the route has succeeded (after its transaction committed, D-215). */
export const TrackProductEvent = (event: RouteEvent) => SetMetadata(PRODUCT_EVENT_KEY, event);

/** Global: runs the route, then records its `@TrackProductEvent` (never on an error; analytics never fails it). */
@Injectable()
export class ProductEventInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly analytics: ProductAnalytics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const event = this.reflector.get<RouteEvent | undefined>(
      PRODUCT_EVENT_KEY,
      context.getHandler(),
    );
    if (!event) return next.handle();
    return next
      .handle()
      .pipe(
        mergeMap((result) =>
          from(
            (event === 'FIRST_CASE_CREATED'
              ? this.analytics.firstCase()
              : this.analytics.track(event, {})
            ).then(() => result),
          ),
        ),
      );
  }
}
