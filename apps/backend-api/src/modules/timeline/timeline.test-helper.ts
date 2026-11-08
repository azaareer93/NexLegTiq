import type { ClsService } from 'nestjs-cls';

import { TimelineService } from './timeline.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { CaseAccessService } from '../legal-files/case-access.service';

/** A real `TimelineService` for unit tests: `record` writes through the test's transaction mock with its context. */
export const testTimeline = (cls: unknown): TimelineService =>
  new TimelineService(
    cls as ClsService<RequestContext>,
    {} as PrismaService,
    {} as CaseAccessService,
  );
