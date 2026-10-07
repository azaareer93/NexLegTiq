import { relationMap, runtimeModels, tenantExtension } from './tenant.extension';

const models = {
  Office: { dbName: 'offices', fields: [{ name: 'users', kind: 'object', type: 'User' }] },
  User: {
    dbName: 'users',
    fields: [
      { name: 'id', kind: 'scalar', type: 'String' },
      { name: 'office', kind: 'object', type: 'Office' },
    ],
  },
};

describe('tenant extension wiring', () => {
  it('should read the runtime data model and fail loudly when it is missing', () => {
    expect(runtimeModels({ _runtimeDataModel: { models } })).toBe(models);
    expect(() => runtimeModels({})).toThrow(/runtime data model not found/);
  });

  it('should map only relation fields', () => {
    expect(relationMap(models)).toEqual(
      new Map([
        ['Office', new Map([['users', 'User']])],
        ['User', new Map([['office', 'Office']])],
      ]),
    );
  });

  it('should refuse a TENANT_MODELS entry that is not a model', () => {
    expect(() =>
      tenantExtension({ models, tenantModels: ['User', 'Ghost'], officeId: () => undefined }),
    ).toThrow(/Ghost/);
  });
});
