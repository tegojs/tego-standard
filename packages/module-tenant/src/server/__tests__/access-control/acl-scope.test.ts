import { ACL, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';

describe('tenant model delegation of built-in role scopes', () => {
  let db: Database;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: ReturnType<typeof configStore>;

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    store = configStore(db);
    acl = new ACL();
    await grantStoredScope(db, acl);
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
  });
  afterEach(async () => {
    await db.close();
  });

  function resolve(ctx: object, params = acl.getRole('member').getActionParams('documents:list')) {
    return adapter.resolve(
      { acl, role: 'member', resource: 'documents', action: 'list', source: 'resource', ctx },
      params,
    );
  }

  it('delegates only a migrated table and retains every non-scope parameter', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    const params = acl.getRole('member').getActionParams('documents:list');
    expect(resolve(ctx, params)).toEqual({ fields: ['id', 'name'], own: false });
    expect(params.filter).toEqual({ tenantId: '{{ ctx.state.currentTenant.id }}' });
  });

  it('preserves old tables, requests without preparation and forged request markers', async () => {
    const ctx = { state: { tenantAccess: true }, headers: { 'x-tenant-access': 'true' } };
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    expect(resolve({ state: { tenantAccess: initialConfig() } }).filter).toBeDefined();
    expect(resolve(ctx).filter).toBeDefined();
  });

  it.each([
    { key: 'custom', scope: { tenantId: '{{ ctx.state.currentTenant.id }}' } },
    { scope: { tenantId: '{{ ctx.state.currentTenant.id }}', active: true } },
    { scope: { $and: [{ tenantId: '{{ ctx.state.currentTenant.id }}' }] } },
    { scope: { tenantId: '{{ ctx.state.currentTenant.id }}', $or: [] } },
    { dataSourceKey: 'other' },
    { resourceName: 'documents' },
  ])('retains modified/custom same-key scopes: %j', async (scopeValues) => {
    await grantStoredScope(db, acl, scopeValues);
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    const params = acl.getRole('member').getActionParams('documents:list');
    expect(resolve(ctx, params)).toEqual(params);
  });

  it('retains both scopes when the built-in identity is ambiguous', async () => {
    await grantStoredScope(db, acl);
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toEqual({ tenantId: '{{ ctx.state.currentTenant.id }}' });
  });

  it('does not delegate a stale grant after its persisted scope is replaced with a different ID', async () => {
    const scopes = db.getCollection('dataSourcesRolesResourcesScopes').model;
    await scopes.destroy({ where: {} });
    await scopes.create({
      key: 'tenant',
      dataSourceKey: 'main',
      scope: { tenantId: '{{ ctx.state.currentTenant.id }}' },
    });
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
  });

  it('retains the grant if the authoritative scope is missing', async () => {
    await db.getCollection('dataSourcesRolesResourcesScopes').model.destroy({ where: {} });
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
  });

  it('retains the grant if its persisted scope was changed without reloading the role', async () => {
    await db
      .getCollection('dataSourcesRolesResourcesScopes')
      .model.update(
        { scope: { tenantId: '{{ ctx.state.currentTenant.id }}', active: true } },
        { where: { key: 'tenant' } },
      );
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
  });

  it('retains the grant if the scope collection is unavailable', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const getCollection = db.getCollection.bind(db);
    vi.spyOn(db, 'getCollection').mockImplementation((name) =>
      name === 'dataSourcesRolesResourcesScopes' ? undefined : getCollection(name),
    );
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
  });

  it('reads scope identity once from the primary per prepared phase and skips old configurations', async () => {
    const lookup = vi.spyOn(db.getCollection('dataSourcesRolesResourcesScopes').model, 'findAll');
    await adapter.prepare({}, [mainIdentity]);
    expect(lookup).not.toHaveBeenCalled();
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeUndefined();
    expect(resolve(ctx).filter).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ useMaster: true, limit: 2 }));
    adapter.release(ctx);
    await grantStoredScope(db, acl);
    lookup.mockClear();
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not treat the legacy ACL scope table as the tenant plugin built-in source', async () => {
    await grantStoredScope(db, acl, {}, 'rolesResourcesScopes');
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    expect(resolve(ctx).filter).toBeDefined();
  });

  it('does not remove filters changed by another resolver', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    const params = { filter: { tenantId: '{{ ctx.state.currentTenant.id }}', active: true }, fields: ['id'] };
    expect(resolve(ctx, params)).toEqual(params);
  });

  it('isolates request snapshots and does not globally modify role grants', async () => {
    const oldRequest = {};
    await adapter.prepare(oldRequest, [mainIdentity]);
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const newRequest = {};
    await adapter.prepare(newRequest, [mainIdentity]);
    expect(adapter.configuration(oldRequest, mainIdentity)).toBeNull();
    expect(adapter.configuration(newRequest, mainIdentity).revision).toBe(1);
    expect(resolve(newRequest).filter).toBeUndefined();
    expect(resolve(oldRequest).filter).toBeDefined();
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list' }).params.filter).toBeDefined();
    adapter.release(newRequest);
    expect(resolve(newRequest).filter).toBeDefined();
  });

  it('shares exactly the prepared config with the query adapter and verifies persistent collection identity', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    await store.save(mainIdentity, { ...initialConfig(), revision: 1, rules: [] }, { userId: 28 });
    expect(adapter.configuration(ctx, mainIdentity).rules).toHaveLength(1);
    expect(adapter.configuration(ctx, mainIdentity).revision).toBe(1);
    expect(() => adapter.configuration(ctx, { ...mainIdentity, collectionKey: 'recreated' })).toThrow('identity');
    expect(() => adapter.configuration({}, mainIdentity)).toThrow('identity');
    expect(() => adapter.configuration(ctx, externalIdentity)).toThrow('identity');
  });

  it('keeps datasource identities separate and rejects a mismatched preparation', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    await store.save(externalIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await expect(adapter.prepare(ctx, [externalIdentity])).rejects.toThrow('data source');
    expect(resolve(ctx).filter).toBeDefined();
    const external = new AccessAclScopeAdapter(acl, 'external', store, db);
    await external.prepare(ctx, [externalIdentity]);
    const args = { acl, role: 'member', resource: 'documents', action: 'list', source: 'resource' as const, ctx };
    const params = acl.getRole('member').getActionParams('documents:list');
    expect(external.resolve(args, params)).toEqual(params);
  });

  it('does not delegate strategy grants or contexts from another ACL instance', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    const params = acl.getRole('member').getActionParams('documents:list');
    const args = { acl, role: 'member', resource: 'documents', action: 'list', ctx };
    expect(adapter.resolve({ ...args, source: 'strategy' }, params)).toEqual(params);
    expect(adapter.resolve({ ...args, acl: new ACL(), source: 'resource' }, params)).toEqual(params);
  });

  it('does not erase scope after a runtime re-grant or revocation', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    acl.getRole('member').grantAction('documents:view', { filter: { tenantId: '{{ ctx.state.currentTenant.id }}' } });
    expect(resolve(ctx).filter).toBeDefined();
  });

  it('rejects repeated preparation and invalid stored config instead of reusing old authorization', async () => {
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    await expect(adapter.prepare(ctx, [mainIdentity])).rejects.toThrow('already');
    await db.getRepository('collections').update({ filterByTk: 'documents', values: { tenantAccess: null } });
    const invalid = {};
    await expect(adapter.prepare(invalid, [mainIdentity])).rejects.toThrow();
    expect(resolve(invalid).filter).toBeDefined();
  });

  it('does not publish a delayed snapshot after its request phase has ended', async () => {
    await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const original = store.read.bind(store);
    let resume: () => void;
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(store, 'read').mockImplementationOnce(async (identity) => {
      await delayed;
      return original(identity);
    });
    const ctx = {};
    const pending = adapter.prepare(ctx, [mainIdentity]);
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    resume();
    await expect(pending).rejects.toThrow('ended');
    expect(resolve(ctx).filter).toBeUndefined();
  });

  it('rejects explicit registration when the installed core lacks the extension', () => {
    const unsupported = Object.create(acl);
    unsupported.registerActionParamsResolver = undefined;
    expect(() => new AccessAclScopeAdapter(unsupported, 'main', store, db).register()).toThrow(
      'ACL action parameters resolver',
    );
  });
});
