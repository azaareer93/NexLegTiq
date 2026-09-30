import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TENANT_MODELS } from './tenant-models';

describe('TENANT_MODELS', () => {
  it('should list exactly the models with a required officeId column', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const withOfficeId = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s*officeId\s+String\s/m.test(body ?? ''))
      .map(([, name]) => name);

    expect([...TENANT_MODELS].sort()).toEqual(withOfficeId.sort());
  });
});
