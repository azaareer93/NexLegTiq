import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import type { ProductAnalytics } from './product-analytics';
import { ProductEventInterceptor, TrackProductEvent } from './product-event.interceptor';

class Routes {
  @TrackProductEvent('HEARING_SCHEDULED')
  hearing(): string {
    return 'hearing';
  }

  @TrackProductEvent('FIRST_CASE_CREATED')
  createCase(): string {
    return 'case';
  }

  plain(): string {
    return 'plain';
  }
}

function setup() {
  const analytics = {
    track: jest.fn().mockResolvedValue(undefined),
    firstCase: jest.fn().mockResolvedValue(undefined),
  };
  const interceptor = new ProductEventInterceptor(
    new Reflector(),
    analytics as unknown as ProductAnalytics,
  );
  const run = (handler: () => string, next: CallHandler<unknown>) =>
    firstValueFrom(
      interceptor.intercept({ getHandler: () => handler } as unknown as ExecutionContext, next),
    );
  return { analytics, run };
}

describe('ProductEventInterceptor (D-215)', () => {
  it("should record the route's event after it succeeded and pass its result on", async () => {
    const { analytics, run } = setup();
    await expect(run(Routes.prototype.hearing, { handle: () => of('ok') })).resolves.toBe('ok');
    expect(analytics.track).toHaveBeenCalledWith('HEARING_SCHEDULED', {});
  });

  it('should hand a new case to firstCase, which knows whether it is the first', async () => {
    const { analytics, run } = setup();
    await run(Routes.prototype.createCase, { handle: () => of({ id: 'c1' }) });
    expect(analytics.firstCase).toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('should record nothing for a failed route or an undecorated one', async () => {
    const { analytics, run } = setup();
    await expect(
      run(Routes.prototype.hearing, { handle: () => throwError(() => new Error('refused')) }),
    ).rejects.toThrow('refused');
    await run(Routes.prototype.plain, { handle: () => of(1) });
    expect(analytics.track).not.toHaveBeenCalled();
  });
});
