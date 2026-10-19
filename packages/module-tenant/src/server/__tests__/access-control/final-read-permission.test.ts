import { ACL } from '@tego/server';

import { captureFinalReadPermission } from '../../access-control/final-read-permission';

describe('final read permission', () => {
  const expected = { resourceName: 'documents', actionName: 'list', roleName: 'reader' };
  const permission = () => ({
    resourceName: 'documents',
    actionName: 'list',
    can: { resource: 'documents', action: 'list', role: 'reader', params: { filter: { name: 'raw' } } },
    parsedParams: { fields: ['amount'], filter: { name: 'resolved' } },
    rawParams: { fields: ['secret'], filter: {} },
    mergedParams: { fields: ['secret'], filter: {} },
  });

  it('uses only final parsed params and snapshots nested constraints', () => {
    const source = permission();
    const result = captureFinalReadPermission(source, expected);
    source.parsedParams.fields.push('secret');
    source.parsedParams.filter.name = 'changed';
    expect(result).toEqual({ allowed: true, params: { fields: ['amount'], filter: { name: 'resolved' } } });
  });

  it.each([null, undefined, false])('does not promote a missing operation decision %s', (can) => {
    expect(captureFinalReadPermission({ ...permission(), can }, expected)).toEqual({ allowed: false, params: {} });
  });

  it('accepts only an explicit finalized core skip and still requires parsed constraints', () => {
    expect(captureFinalReadPermission({ ...permission(), can: null, skip: true }, expected)).toEqual({
      allowed: true,
      params: permission().parsedParams,
    });
    expect(() => captureFinalReadPermission({ ...permission(), can: null, skip: 1 }, expected)).toThrow();
  });

  it.each([
    { resourceName: 'projects' },
    { actionName: 'get' },
    { can: { resource: 'projects', action: 'list', role: 'reader' } },
    { can: { resource: 'documents', action: 'get', role: 'reader' } },
    { can: { resource: 'documents', action: 'list', role: 'root' } },
    { can: true },
    { parsedParams: undefined },
    { parsedParams: null },
  ])('rejects mismatched or incomplete authorization %j', (extra) => {
    expect(() => captureFinalReadPermission({ ...permission(), ...extra }, expected)).toThrow();
  });

  it('does not use raw ACL or request params when parsed params are absent', () => {
    const { parsedParams: _params, ...source } = permission();
    expect(() => captureFinalReadPermission(source, expected)).toThrow();
  });

  it('preserves non-enumerable final field restrictions without invoking getters', () => {
    const source = permission();
    Object.defineProperty(source.parsedParams, 'fields', { value: [], enumerable: false });
    expect(
      Object.getOwnPropertyDescriptor(captureFinalReadPermission(source, expected).params, 'fields')?.value,
    ).toEqual([]);
    const getter = vi.fn(() => source.parsedParams);
    Object.defineProperty(source, 'parsedParams', { get: getter });
    expect(() => captureFinalReadPermission(source, expected)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects decision and nested parameter getters without evaluating them', () => {
    const getter = vi.fn(() => true);
    for (const key of ['can', 'skip', 'resourceName', 'actionName']) {
      const source = permission();
      Object.defineProperty(source, key, { get: getter });
      expect(() => captureFinalReadPermission(source, expected)).toThrow();
    }
    const source = permission();
    Object.defineProperty(source.can, 'role', { get: getter });
    expect(() => captureFinalReadPermission(source, expected)).toThrow();
    const nested = permission();
    Object.defineProperty(nested.parsedParams.filter, 'name', { get: getter });
    expect(() => captureFinalReadPermission(nested, expected)).toThrow();
    const binding = { ...expected };
    Object.defineProperty(binding, 'roleName', { get: getter });
    expect(() => captureFinalReadPermission(permission(), binding)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects unavailable context and invalid trusted bindings', () => {
    for (const source of [undefined, null, [], true])
      expect(() => captureFinalReadPermission(source, expected)).toThrow();
    for (const binding of [
      { ...expected, roleName: '' },
      { ...expected, resourceName: 'a'.repeat(256) },
      { ...expected, actionName: 'li\0st' },
    ])
      expect(() => captureFinalReadPermission(permission(), binding)).toThrow();
  });

  it('does not inspect final params after a denied operation', () => {
    const source = { ...permission(), can: null };
    const getter = vi.fn();
    Object.defineProperty(source, 'parsedParams', { get: getter });
    expect(captureFinalReadPermission(source, expected)).toEqual({ allowed: false, params: {} });
    expect(getter).not.toHaveBeenCalled();
  });

  it('captures real core middleware results after aliases, fixed scopes and variables resolve', async () => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    acl.define({ role: 'reader' }).grantAction('documents:view', {
      fields: ['amount'],
      filter: { name: '{{ ctx.state.currentUser.name }}' },
    });
    acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
    const context = {
      state: { currentRole: 'reader', currentUser: { name: 'Visible' } },
      action: { resourceName: 'documents', actionName: 'list', params: { fields: ['secret'] }, mergeParams: vi.fn() },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
    };
    let result: ReturnType<typeof captureFinalReadPermission> | undefined;
    await acl.middleware()(context as never, async () => {
      result = captureFinalReadPermission(context.permission, expected);
    });
    expect(result).toEqual({
      allowed: true,
      params: { fields: ['amount'], filter: { name: 'Visible', amount: { $gte: 15 } } },
    });
    expect(context.action.mergeParams).toHaveBeenCalledOnce();
  });
});
