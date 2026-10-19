import { officesApi } from '@nexlegtiq/shared-api-client';
import { useQuery } from '@tanstack/react-query';

import { apiClient, subscriptionKey } from '../../auth';

const offices = officesApi(apiClient);

/** `GET /offices/me/subscription` (D-122): plan, status, limits and usage; also drives the read-only banner. */
export const useSubscription = () =>
  useQuery({
    queryKey: subscriptionKey,
    queryFn: ({ signal }) => offices.subscription(signal),
    staleTime: 60_000,
  });
