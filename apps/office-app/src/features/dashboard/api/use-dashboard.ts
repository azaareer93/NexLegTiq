import { dashboardApi } from '@nexlegtiq/shared-api-client';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const dashboard = dashboardApi(apiClient);

export const dashboardKeys = { all: ['dashboard'] as const };

/** `GET /dashboard` (D-151); refetched when the window regains focus, like every query. */
export const useDashboard = () =>
  useQuery({ queryKey: dashboardKeys.all, queryFn: ({ signal }) => dashboard.get(signal) });
