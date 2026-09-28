import { killPort } from '@nx/node/utils';

import { apiPort } from './env';

export default async function globalTeardown(): Promise<void> {
  await killPort(apiPort);
}
