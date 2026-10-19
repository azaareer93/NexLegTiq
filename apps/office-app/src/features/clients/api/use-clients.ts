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

/**
 * `GET /clients/:id`: the client with its decrypted ids and contact persons (D-108). Dropped from the cache as soon as
 * nothing shows it (`gcTime: 0`): national and tax ids are not kept in memory longer than the drawer is open.
 */
export const useClient = (id: string | null) =>
  useQuery({
    queryKey: clientKeys.detail(id ?? ''),
    queryFn: ({ signal }) => clients.get(id ?? '', signal),
    enabled: id !== null,
    gcTime: 0,
  });

/** A write that answers with the client: it replaces the cached detail, and every list refetches. */
function useClientWrite<T>(mutationFn: (body: T) => Promise<Client>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // The body may hold national and tax ids: not kept once the call is done.
    gcTime: 0,
    onSuccess: (client: Client) => {
      queryClient.setQueryData(clientKeys.detail(client.id), client);
      void queryClient.invalidateQueries({ queryKey: clientKeys.lists() });
    },
  });
}

/** A write to a client's contact persons: only that client's detail changes (lists do not show contacts). */
function useContactWrite<T>(id: string, mutationFn: (body: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: clientKeys.detail(id) }),
  });
}

export const useCreateClient = () =>
  useClientWrite((body: CreateClientRequest) => clients.create(body));

export const useUpdateClient = (id: string) =>
  useClientWrite((body: UpdateClientRequest) => clients.update(id, body));

export const useAddContact = (id: string) =>
  useContactWrite(id, (body: CreateContactPersonRequest) => clients.addContact(id, body));

export const useUpdateContact = (id: string) =>
  useContactWrite(
    id,
    ({ contactId, ...body }: UpdateContactPersonRequest & { contactId: string }) =>
      clients.updateContact(id, contactId, body),
  );

export const useRemoveContact = (id: string) =>
  useContactWrite(id, (contactId: string) => clients.removeContact(id, contactId));
