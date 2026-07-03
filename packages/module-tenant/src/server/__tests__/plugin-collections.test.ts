import type { MockServer } from '@tachybase/test';

import { NAMESPACE } from '../../constants';
import { createTenantApp } from './utils';

function filterContainsTenantScopeGuard(filter: any): boolean {
  if (!filter || typeof filter !== 'object') {
    return false;
  }

  if (filter['key.$ne'] === 'tenant') {
    return true;
  }

  return Object.values(filter).some((value: any) =>
    Array.isArray(value)
      ? value.some((item) => filterContainsTenantScopeGuard(item))
      : filterContainsTenantScopeGuard(value),
  );
}

describe('tenant plugin collections', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createTenantApp();
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should not define an explicit tenantUsers field on tenants collection', async () => {
    const tenantsCollection = app.db.getCollection('tenants');

    expect(tenantsCollection.getField('tenantUsers')).toBeFalsy();
    expect(tenantsCollection.getField('id')).toBeTruthy();
    expect(app.db.getCollection('users').getField('tenants')).toBeTruthy();
  });

  it('should register tenant management acl snippet', async () => {
    const snippet = app.acl.snippetManager.snippets.get('pm.tenant.manage');

    expect(snippet).toBeTruthy();
    expect(snippet.actions).toEqual(
      expect.arrayContaining(['tenants:*', 'tenantUsers:*', 'users:list', 'users:update']),
    );
  });

  it('should protect tenant acl scope records on create/update/destroy', async () => {
    app.acl.define({
      role: 'tenant-acl-scope-test',
      actions: {
        'rolesResourcesScopes:create': {},
        'rolesResourcesScopes:update': {},
        'rolesResourcesScopes:destroy': {},
      },
    });

    for (const action of ['create', 'update', 'destroy']) {
      const canResult = app.acl.can({
        role: 'tenant-acl-scope-test',
        resource: 'rolesResourcesScopes',
        action,
      });

      expect(filterContainsTenantScopeGuard(canResult?.params?.filter)).toBe(true);
    }
  });

  it('should register locale resources with tenant namespace', async () => {
    expect(app.i18n.t('Tenant management', { lng: 'zh-CN', ns: NAMESPACE })).toBe('租户管理');
  });

  it('should not overwrite custom tenantId field metadata when collection tenancy is enabled', async () => {
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_meta_posts',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
          {
            type: 'string',
            name: 'tenantId',
            dataIndex: 'wrong.path',
            createOnly: false,
          },
        ],
      },
      context: {},
    });

    await app.db.getRepository('collections').update({
      filterByTk: 'tenant_meta_posts',
      values: {
        tenancy: 'tenantScoped',
      },
      context: {},
    });

    const field = await app.db.getRepository('fields').findOne({
      filter: {
        collectionName: 'tenant_meta_posts',
        name: 'tenantId',
      },
    });

    expect(field.get('type')).toBe('string');
    expect(field.get('dataIndex')).toBe('wrong.path');
    expect(field.get('createOnly')).toBe(false);
  });

  it('should remove managed tenantId field metadata when collection tenancy is disabled', async () => {
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_meta_disable_posts',
        tenancy: 'tenantScoped',
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    expect(app.db.getCollection('tenant_meta_disable_posts').getField('tenantId')).toBeTruthy();

    await app.db.getRepository('collections').update({
      filterByTk: 'tenant_meta_disable_posts',
      values: {
        tenancy: 'shared',
      },
      context: {},
    });

    const field = await app.db.getRepository('fields').findOne({
      filter: {
        collectionName: 'tenant_meta_disable_posts',
        name: 'tenantId',
      },
    });

    expect(field).toBeNull();
    expect(app.db.getCollection('tenant_meta_disable_posts').getField('tenantId')).toBeFalsy();
  });
});
