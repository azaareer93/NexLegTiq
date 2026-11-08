import { casesApi } from '@nexlegtiq/shared-api-client';
import type { TimelineEventType } from '@nexlegtiq/shared-types';
import { useInfiniteQuery } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const cases = casesApi(apiClient);

/** Under the file's detail key: the realtime bridge refreshes `cases/detail/{fileId}` on the file's events (D-129). */
export const timelineKey = (fileId: string, types: readonly TimelineEventType[]) =>
  ['cases', 'detail', fileId, 'timeline', [...types].sort()] as const;

const PAGE = 20;

/** The file's history, newest first, 20 events a page (D-150). */
export const useTimeline = (fileId: string, types: readonly TimelineEventType[]) =>
  useInfiniteQuery({
    queryKey: timelineKey(fileId, types),
    queryFn: ({ pageParam, signal }) =>
      cases.timeline(
        fileId,
        {
          limit: PAGE,
          ...(types.length ? { types: types.join(',') } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
