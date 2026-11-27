import { RoleActionParamsMerge } from '../acl/RoleActionParamsMerge';

describe('merged role action parameters', () => {
  it('retains the finite grant of a single source without mutating it', () => {
    const source = Object.freeze({
      fields: ['name'],
      filter: { status: 'draft' },
      own: true,
      whitelist: ['name'],
      blacklist: ['memo'],
    });
    const merged = RoleActionParamsMerge.merge([source]);
    expect(merged).toEqual({
      fields: ['name'],
      filter: { status: 'draft' },
      own: true,
      whitelist: ['name'],
      blacklist: ['memo'],
    });
    expect(merged).not.toBe(source);
    expect(source).toEqual({
      fields: ['name'],
      filter: { status: 'draft' },
      own: true,
      whitelist: ['name'],
      blacklist: ['memo'],
    });
  });

  it('combines finite grants while retaining their filter and exclusion strategies', () => {
    expect(
      RoleActionParamsMerge.merge([
        {
          fields: ['name'],
          filter: { status: 'draft' },
          own: false,
          whitelist: ['name'],
          blacklist: ['memo', 'tenantId'],
        },
        {
          fields: ['amount', 'name'],
          filter: { status: 'ready' },
          own: true,
          whitelist: ['amount'],
          blacklist: ['memo'],
        },
      ]),
    ).toEqual({
      fields: ['name', 'amount'],
      filter: { $or: [{ status: 'draft' }, { status: 'ready' }] },
      own: true,
      whitelist: ['name', 'amount'],
      blacklist: ['memo'],
    });
  });
});
