import { adminPlansApi } from '@nexlegtiq/shared-api-client';
import type { CreatePlanRequest, UpdatePlanRequest } from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { planKeys } from './keys';
import { apiClient } from '../auth/session';

const plans = adminPlansApi(apiClient);

export const usePlansList = () =>
  useQuery({ queryKey: planKeys.list(), queryFn: ({ signal }) => plans.list(signal) });

/** Create, update or delete a plan; the list refetches afterwards. */
export function usePlanMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: planKeys.all });
  const create = useMutation({
    mutationFn: (body: CreatePlanRequest) => plans.create(body),
    gcTime: 0,
    onSuccess,
  });
  const update = useMutation({
    mutationFn: (args: { id: string; body: UpdatePlanRequest }) => plans.update(args.id, args.body),
    gcTime: 0,
    onSuccess,
  });
  const remove = useMutation({ mutationFn: (id: string) => plans.remove(id), onSuccess });
  return { create, update, remove };
}
