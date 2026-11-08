import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { TimelineService } from './timeline.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { DocumentAccessService } from '../documents/document-access.service';
import type { CaseAccessService } from '../legal-files/case-access.service';

/** A real `TimelineService` for unit tests: `record` writes through the test's transaction mock with its context. */
export const testTimeline = (cls: unknown): TimelineService =>
  new TimelineService(
    cls as ClsService<RequestContext>,
    {} as PrismaService,
    {} as CaseAccessService,
    {} as DocumentAccessService,
    { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger,
  );
