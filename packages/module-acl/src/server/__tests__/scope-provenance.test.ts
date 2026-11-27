import { ACL, mockDatabase, type Database } from '@tego/server';

import { getRoleActionScope, RoleResourceActionModel } from '..';

describe('persisted ACL scope provenance', () => {
  let db: Database;
  let acl: ACL;

  beforeEach(async () => {
    db = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    db.registerModels({ RoleResourceActionModel });
    for (const name of ['rolesResourcesScopes', 'dataSourcesRolesResourcesScopes']) {
      db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'key', type: 'string' },
          { name: 'dataSourceKey', type: 'string' },
          { name: 'resourceName', type: 'string' },
          { name: 'scope', type: 'json' },
        ],
      });
    }
    db.collection({
      name: 'actions',
      model: 'RoleResourceActionModel',
      timestamps: false,
      fields: [
        { name: 'name', type: 'string' },
        { name: 'fields', type: 'array' },
        { name: 'scope', type: 'belongsTo', target: 'dataSourcesRolesResourcesScopes' },
      ],
    });
    await db.sync();
    acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    acl.define({ role: 'member' });
  });

  afterEach(async () => {
    await db.close();
  });

  async function grant(scopeValues = { tenantId: '{{ ctx.state.currentTenant.id }}' }, actionName = 'view') {
    const scope = await db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: { key: 'tenant', dataSourceKey: 'main', scope: scopeValues },
    });
    const action = await db.getRepository('actions').create({
      values: { name: actionName, fields: ['id', 'name'], scopeId: scope.get('id') },
    });
    await action.writeToACL({
      acl,
      role: acl.getRole('member'),
      resourceName: 'documents',
      associationFieldsActions: {},
      grantHelper: {},
    });
    return { action, scope };
  }

  it('records persistent scope identity without exposing provenance in permission JSON', async () => {
    const { scope } = await grant();
    const role = acl.getRole('member');
    expect(getRoleActionScope(role, 'documents', 'list')).toEqual({
      scopeCollection: 'dataSourcesRolesResourcesScopes',
      scopeId: scope.get('id'),
      key: 'tenant',
      dataSourceKey: 'main',
      resourceName: null,
      filter: { tenantId: '{{ ctx.state.currentTenant.id }}' },
    });
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list' }).params).toEqual({
      fields: ['id', 'name'],
      own: false,
      filter: { tenantId: '{{ ctx.state.currentTenant.id }}' },
    });
    expect(JSON.stringify(role.toJSON())).not.toContain('scopeCollection');
  });

  it('returns an independent scope snapshot', async () => {
    await grant();
    const role = acl.getRole('member');
    const source = getRoleActionScope(role, 'documents', 'view');
    (source.filter as Record<string, unknown>).tenantId = 'changed';
    expect(getRoleActionScope(role, 'documents', 'view').filter).toEqual({
      tenantId: '{{ ctx.state.currentTenant.id }}',
    });
  });

  it('does not infer source for programmatic grants that happen to use the same filter', async () => {
    await grant();
    const role = acl.getRole('member');
    role.grantAction('documents:view', { filter: { tenantId: '{{ ctx.state.currentTenant.id }}' } });
    expect(getRoleActionScope(role, 'documents', 'list')).toBeUndefined();
  });

  it('invalidates source after revocation and after a new grant', async () => {
    await grant();
    const role = acl.getRole('member');
    role.revokeResource('documents');
    expect(getRoleActionScope(role, 'documents', 'get')).toBeUndefined();
    role.grantAction('documents:view', {});
    expect(getRoleActionScope(role, 'documents', 'get')).toBeUndefined();
  });

  it('does not reuse provenance if runtime code changes the grant filter', async () => {
    await grant();
    const role = acl.getRole('member');
    role.getResource('documents').actions.get('view').filter.tenantId = 'custom';
    expect(getRoleActionScope(role, 'documents', 'list')).toBeUndefined();
  });

  it('does not delegate filters modified by a grant hook', async () => {
    acl.beforeGrantAction((context) => {
      context.params.filter.active = true;
    });
    await grant();
    expect(getRoleActionScope(acl.getRole('member'), 'documents', 'get')).toBeUndefined();
  });

  it('prefers the actual exact action grant over its alias', async () => {
    await grant();
    const role = acl.getRole('member');
    role.grantAction('documents:list', { filter: { active: true } });
    expect(getRoleActionScope(role, 'documents', 'list')).toBeUndefined();
    expect(getRoleActionScope(role, 'documents', 'get')).toBeDefined();
  });

  it('does not reuse another role or ACL instance source', async () => {
    await grant();
    const other = new ACL();
    other.define({
      role: 'member',
      actions: { 'documents:view': { filter: { tenantId: '{{ ctx.state.currentTenant.id }}' } } },
    });
    expect(getRoleActionScope(other.getRole('member'), 'documents', 'get')).toBeUndefined();
  });
});
