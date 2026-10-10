import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REFERENCE_MODELS, TENANT_MODELS } from './tenant-models';

const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
const modelsWith = (column: RegExp) =>
  [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter(([, , body]) => column.test(body ?? ''))
    .map(([, name]) => name)
    .sort();

describe('TENANT_MODELS', () => {
  it('should list exactly the models with a required officeId column', () => {
    expect([...TENANT_MODELS].sort()).toEqual(modelsWith(/^\s*officeId\s+String\s/m));
  });
});

describe('REFERENCE_MODELS', () => {
  it('should list exactly the models with an optional officeId column (D-037, D-115)', () => {
    expect([...REFERENCE_MODELS].sort()).toEqual(modelsWith(/^\s*officeId\s+String\?\s/m));
  });
});
