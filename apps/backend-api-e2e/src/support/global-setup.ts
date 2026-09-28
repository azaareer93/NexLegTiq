import { waitForPortOpen } from '@nx/node/utils';

import { apiHost, apiPort } from './env';

// Waits for `backend-api:serve` (started by the e2e target's dependsOn). Real PG/Redis come with MVP-30/31.
export default async function globalSetup(): Promise<void> {
  await waitForPortOpen(apiPort, { host: apiHost });
}
