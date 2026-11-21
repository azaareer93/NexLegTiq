import { Injectable, SetMetadata } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';

import { ProductAnalytics } from './product-analytics';

/** The events a route records (D-215): no props, except FIRST_CASE_CREATED, which works out its own. */
type RouteEvent =
  | 'FIRST_CASE_CREATED'
  | 'HEARING_SCHEDULED'
  | 'DOCUMENT_UPLOADED'
  | 'INVITE_SENT'
  | 'PORTAL_INVITE_SENT';

const PRODUCT_EVENT_KEY = 'nlq:product-event';

/** Records `event` for the caller's office once the route has succeeded (after its transaction committed, D-215). */
export const TrackProductEvent = (event: RouteEvent) => SetMetadata(PRODUCT_EVENT_KEY, event);

/**
 * Global: runs the route, then records its `@TrackProductEvent` without holding the response back (never on an
 * error; analytics never throws).
 */
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
    return next.handle().pipe(
      tap(() => {
        void (event === 'FIRST_CASE_CREATED'
          ? this.analytics.firstCase()
          : this.analytics.track(event, {}));
      }),
    );
  }
}
