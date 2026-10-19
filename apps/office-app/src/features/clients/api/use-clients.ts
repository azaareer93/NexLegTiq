import { clientsApi } from '@nexlegtiq/shared-api-client';
import type { ClientListParams } from '@nexlegtiq/shared-api-client';
import type {
  Client,
  CreateClientRequest,
  CreateContactPersonRequest,
  UpdateClientRequest,
  UpdateContactPersonRequest,
} from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

export const clients = clientsApi(apiClient);

export const clientKeys = {
  all: ['clients'] as const,
  lists: () => [...clientKeys.all, 'list'] as const,
  list: (query: ClientListParams) => [...clientKeys.lists(), query] as const,
  detail: (id: string) => [...clientKeys.all, 'detail', id] as const,
};

/** One page of `GET /clients`; the previous page stays on screen while the next loads. */
export const useClientsList = (query: ClientListParams, enabled = true) =>
  useQuery({
    queryKey: clientKeys.list(query),
    queryFn: ({ signal }) => clients.list(query, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

/** `GET /clients/:id`: the client with its decrypted ids and contact persons (D-108). */
export const useClient = (id: string | null) =>
  useQuery({
    queryKey: clientKeys.detail(id ?? ''),
    queryFn: ({ signal }) => clients.get(id ?? '', signal),
    enabled: id !== null,
  });

/** Every write answers with the client (or touches its contacts): refresh the detail and every list. */
function useClientMutation<T, R>(mutationFn: (body: T) => Promise<R>, id?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (answer: R) => {
      const client = answer as Partial<Client> | undefined;
      if (client?.id && client.contacts) {
        queryClient.setQueryData(clientKeys.detail(client.id), client);
      } else if (id) {
        void queryClient.invalidateQueries({ queryKey: clientKeys.detail(id) });
      }
      void queryClient.invalidateQueries({ queryKey: clientKeys.lists() });
    },
  });
}

export const useCreateClient = () =>
  useClientMutation((body: CreateClientRequest) => clients.create(body));

export const useUpdateClient = (id: string) =>
  useClientMutation((body: UpdateClientRequest) => clients.update(id, body));

export const useAddContact = (id: string) =>
  useClientMutation((body: CreateContactPersonRequest) => clients.addContact(id, body), id);

export const useUpdateContact = (id: string) =>
  useClientMutation(
    ({ contactId, ...body }: UpdateContactPersonRequest & { contactId: string }) =>
      clients.updateContact(id, contactId, body),
    id,
  );

export const useRemoveContact = (id: string) =>
  useClientMutation((contactId: string) => clients.removeContact(id, contactId), id);
