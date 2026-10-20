import { ACL, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('role scope migration preview (%s)', (dialect) => {
  let db: Database;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let granted: Awaited<ReturnType<typeof grantStoredScope>>;
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    acl = new ACL();
    granted = await grantStoredScope(db, acl);
    adapter = new AccessAclScopeAdapter(acl, 'main', configStore(db), db);
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", ' +
            '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db?.close();
    }
  });

  const preview = (role = 'member', action = 'list') => adapter.previewRoleScope(role, 'documents', action);

  it('previews the exact built-in source before migration without writing configuration or changing ACL', async () => {
    const before = structuredClone(acl.getRole('member').getActionParams('documents:list'));
    const writes = vi.spyOn(db.getRepository('collections'), 'update');
    expect(await preview()).toMatchObject({
      dataSourceKey: 'main',
      role: 'member',
      resource: 'documents',
      action: 'list',
      treatment: 'delegate-builtin-scope',
      params: before,
      scope: { scopeCollection: 'dataSourcesRolesResourcesScopes', scopeId: granted.scope.get('id') },
    });
    expect(await configStore(db).read(mainIdentity)).toBeNull();
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(acl.getRole('member').getActionParams('documents:list')).toEqual(before);
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list' }).params.filter).toEqual(before.filter);
  });

  it('returns detached output, preserves field restrictions, and resolves aliases', async () => {
    const report = await preview();
    report.params.fields.push('private');
    report.params.filter.tenantId = 'forged';
    (report.scope.filter as Record<string, unknown>).tenantId = 'forged';
    const next = await preview('member', 'get');
    expect(next).toMatchObject({ treatment: 'delegate-builtin-scope', params: { fields: ['id', 'name'] } });
    expect(next.params.filter).toEqual({ tenantId: '{{ ctx.state.currentTenant.id }}' });
    expect(next.scope.filter).toEqual(next.params.filter);
  });

  it.each([
    { key: 'custom' },
    { scope: { tenantId: '{{ ctx.state.currentTenant.id }}', active: true } },
    { scope: { $and: [{ tenantId: '{{ ctx.state.currentTenant.id }}' }] } },
    { resourceName: 'documents' },
    { dataSourceKey: 'external' },
  ])('retains customized/same-named scopes %j', async (values) => {
    await granted.scope.update(values);
    await granted.action.writeToACL({
      acl,
      role: acl.getRole('member'),
      resourceName: 'documents',
      associationFieldsActions: {},
      grantHelper: {},
    });
    expect(await preview()).toMatchObject({ treatment: 'retain-role-scope' });
  });

  it('retains an ambiguous built-in scope instead of promising a delegation', async () => {
    await grantStoredScope(db, acl);
    expect(await preview()).toMatchObject({ treatment: 'retain-role-scope' });
  });

  it('retains a stale scope whose authoritative persisted identity was replaced', async () => {
    await db.getRepository('dataSourcesRolesResourcesScopes').destroy({ filterByTk: granted.scope.get('id') });
    await db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        key: 'tenant',
        dataSourceKey: 'main',
        scope: { tenantId: '{{ ctx.state.currentTenant.id }}' },
      },
    });
    expect(await preview()).toMatchObject({ treatment: 'retain-role-scope' });
  });

  it('retains grants whose runtime provenance was invalidated', async () => {
    acl.getRole('member').grantAction('documents:view', { filter: { tenantId: '{{ ctx.state.currentTenant.id }}' } });
    const report = await preview();
    expect(report.treatment).toBe('retain-role-scope');
    expect(report.scope).toBeUndefined();
  });

  it('keeps same-named external sources separate', async () => {
    const external = new AccessAclScopeAdapter(acl, 'external', configStore(db), db);
    expect(await external.previewRoleScope('member', 'documents', 'list')).toMatchObject({
      dataSourceKey: 'external',
      treatment: 'retain-role-scope',
    });
  });

  it('does not interpret missing direct grants as either denial or permission', async () => {
    expect(await preview('missing')).toEqual({
      dataSourceKey: 'main',
      role: 'missing',
      resource: 'documents',
      action: 'list',
      treatment: 'no-direct-resource-grant',
    });
    expect(await preview('member', 'destroy')).toMatchObject({ treatment: 'no-direct-resource-grant' });
    acl.getRole('member').setStrategy({ actions: ['create'] });
    expect(await preview('member', 'create')).toMatchObject({ treatment: 'no-direct-resource-grant' });
  });

  it('retains a grant without a data filter and never creates a new permission', async () => {
    acl.getRole('member').grantAction('documents:create', { fields: ['name'] });
    expect(await preview('member', 'create')).toMatchObject({
      treatment: 'retain-role-scope',
      params: { whitelist: ['name'] },
    });
    expect(acl.getRole('member').getActionParams('documents:destroy')).toBeNull();
  });

  it('agrees with the actual adapter without applying delegation during preview', async () => {
    const report = await preview();
    await configStore(db).save(mainIdentity, initialConfig(), { userId: 28 });
    const ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
    const params = acl.getRole('member').getActionParams('documents:list');
    const resolved = adapter.resolve(
      { acl, role: 'member', resource: 'documents', action: 'list', source: 'resource', ctx },
      params,
    );
    expect(report.treatment).toBe('delegate-builtin-scope');
    expect(resolved.filter).toBeUndefined();
    expect(report.params.filter).toEqual(params.filter);
  });

  it('rejects publication if a role grant changes during asynchronous scope lookup', async () => {
    const scopes = db.getCollection('dataSourcesRolesResourcesScopes').model;
    const findAll = scopes.findAll.bind(scopes);
    vi.spyOn(scopes, 'findAll').mockImplementationOnce(async (options) => {
      acl.getRole('member').grantAction('documents:view', { filter: { active: true } });
      return findAll(options);
    });
    await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
  });

  it('retains a persisted scope modified without reloading its old role grant', async () => {
    await granted.scope.update({ scope: { tenantId: '{{ ctx.state.currentTenant.id }}', active: true } });
    expect(await preview()).toMatchObject({ treatment: 'retain-role-scope' });
  });

  it('retains a same-named scope from the legacy role scope collection', async () => {
    await grantStoredScope(db, acl, {}, 'rolesResourcesScopes');
    expect(await preview()).toMatchObject({ treatment: 'retain-role-scope' });
  });

  it('propagates a scope lookup failure instead of returning a successful migration preview', async () => {
    const failure = new Error('lookup failed');
    vi.spyOn(db.getCollection('dataSourcesRolesResourcesScopes').model, 'findAll').mockRejectedValueOnce(failure);
    await expect(preview()).rejects.toBe(failure);
  });

  it.each(['replace-role', 'mutate-filter', 'mutate-fields'])(
    'rejects %s during asynchronous scope lookup',
    async (change) => {
      const scopes = db.getCollection('dataSourcesRolesResourcesScopes').model;
      const findAll = scopes.findAll.bind(scopes);
      vi.spyOn(scopes, 'findAll').mockImplementationOnce(async (options) => {
        const params = acl.getRole('member').getResource('documents').actions.get('view');
        if (change === 'replace-role') acl.define({ role: 'member' });
        else if (change === 'mutate-filter') params.filter.tenantId = 'changed';
        else params.fields.push('private');
        return findAll(options);
      });
      await expect(preview()).rejects.toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
    },
  );

  it.each(['', null, 1, 'x'.repeat(256)])('rejects invalid inspection identities: %j', async (name) => {
    await expect(preview(name as string)).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    await expect(adapter.previewRoleScope('member', name as string, 'list')).rejects.toMatchObject({
      code: 'INVALID_ACCESS_CONFIG_WRITE',
    });
    await expect(preview('member', name as string)).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });
});
