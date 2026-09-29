import { waitForPortOpen } from '@nx/node/utils';

import { apiHost, apiPort } from './env';

// Waits for `backend-api:serve`, a continuous task Nx starts before and stops after the e2e run.
// Real PG/Redis come with MVP-30/31.
export default async function globalSetup(): Promise<void> {
  await waitForPortOpen(apiPort, { host: apiHost, retries: 60, retryDelay: 1000 });
}
