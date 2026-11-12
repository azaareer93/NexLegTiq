import { WitnessSchema, WitnessStatementSchema } from '@nexlegtiq/shared-contracts';
import type {
  CreateWitnessRequest,
  CreateWitnessStatementRequest,
  UpdateWitnessRequest,
  UpdateWitnessStatementRequest,
  Witness,
  WitnessStatement,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** A file's witnesses and their statements (D-163). */
export function witnessesApi(client: ApiClient) {
  const id = encodeURIComponent;
  const forFile = (fileId: string) => `cases/${id(fileId)}/witnesses`;
  const statementsOf = (witnessId: string) => `witnesses/${id(witnessId)}/statements`;
  return {
    forFile: (fileId: string, signal?: AbortSignal): Promise<Witness[]> =>
      client.request({ method: 'GET', path: forFile(fileId), signal }, WitnessSchema.array()),
    create: (fileId: string, body: CreateWitnessRequest): Promise<Witness> =>
      client.request({ method: 'POST', path: forFile(fileId), body }, WitnessSchema),
    update: (fileId: string, witnessId: string, body: UpdateWitnessRequest): Promise<Witness> =>
      client.request(
        { method: 'PATCH', path: `${forFile(fileId)}/${id(witnessId)}`, body },
        WitnessSchema,
      ),
    remove: (fileId: string, witnessId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: `${forFile(fileId)}/${id(witnessId)}` }),
    statements: (witnessId: string, signal?: AbortSignal): Promise<WitnessStatement[]> =>
      client.request(
        { method: 'GET', path: statementsOf(witnessId), signal },
        WitnessStatementSchema.array(),
      ),
    addStatement: (
      witnessId: string,
      body: CreateWitnessStatementRequest,
    ): Promise<WitnessStatement> =>
      client.request(
        { method: 'POST', path: statementsOf(witnessId), body },
        WitnessStatementSchema,
      ),
    updateStatement: (
      witnessId: string,
      statementId: string,
      body: UpdateWitnessStatementRequest,
    ): Promise<WitnessStatement> =>
      client.request(
        { method: 'PATCH', path: `${statementsOf(witnessId)}/${id(statementId)}`, body },
        WitnessStatementSchema,
      ),
    removeStatement: (witnessId: string, statementId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: `${statementsOf(witnessId)}/${id(statementId)}` }),
  };
}
