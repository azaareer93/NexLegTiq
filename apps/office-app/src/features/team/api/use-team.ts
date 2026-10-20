import { usersApi } from '@nexlegtiq/shared-api-client';
import type { DeactivateUserRequest } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, subscriptionKey } from '../../auth';

const users = usersApi(apiClient);

/** Everything under `['users']`: the team, a user's open files and the pickers' directory (D-123). */
const teamKeys = {
  all: ['users'] as const,
  team: ['users', 'team'] as const,
  openFiles: (id: string) => ['users', 'open-files', id] as const,
};

/** `GET /users` (D-124): the office team, active users first. */
export const useTeam = () =>
  useQuery({ queryKey: teamKeys.team, queryFn: ({ signal }) => users.team(signal) });

/** The open files deactivating `id` must reassign; read fresh each time the wizard opens. */
export const useOpenFiles = (id: string) =>
  useQuery({
    queryKey: teamKeys.openFiles(id),
    queryFn: ({ signal }) => users.openFiles(id, signal),
    gcTime: 0,
  });

/** A team change can move files, seats and the directory: refresh all of them (and the plan usage, D-122). */
function useTeamMutation<T>(run: (vars: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['cases'] }),
        queryClient.invalidateQueries({ queryKey: subscriptionKey }),
      ]);
    },
  });
}

export const useChangeRole = () =>
  useTeamMutation(({ id, role }: { id: string; role: Role }) => users.changeRole(id, { role }));

export const useDeactivate = () =>
  useTeamMutation(({ id, body }: { id: string; body: DeactivateUserRequest }) =>
    users.deactivate(id, body),
  );

export const useReactivate = () => useTeamMutation((id: string) => users.reactivate(id));
