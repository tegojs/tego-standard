import type { MockServer } from '@tachybase/test';

import { NAMESPACE } from '../../constants';
import { TENANT_ERROR_MESSAGES } from '../locale';
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
    expect(tenantsCollection.getField('name')?.options).toMatchObject({
      unique: true,
      allowNull: false,
      required: true,
    });
    expect(tenantsCollection.getField('title')).toBeFalsy();
    expect(app.db.getCollection('users').getField('tenants')).toBeTruthy();
  });

  it('should register tenant management acl snippet', async () => {
    const snippet = app.acl.snippetManager.snippets.get('pm.tenant.manage');

    expect(snippet).toBeTruthy();
    expect(snippet.actions).toEqual(
      expect.arrayContaining([
        'tenants:*',
        'tenantUsers:*',
        'users:list',
        'users:update',
        'collections:list',
        'collections:update',
      ]),
    );
  });

  it('should register tenant impersonation acl snippet separately from tenant management', async () => {
    const snippet = app.acl.snippetManager.snippets.get('pm.tenant.impersonate');

    expect(snippet).toBeTruthy();
    expect(snippet.actions).toEqual(expect.arrayContaining(['tenants:available', 'tenants:current', 'tenants:switch']));
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
    for (const message of Object.values(TENANT_ERROR_MESSAGES)) {
      expect(app.i18n.t(message, { lng: 'zh-CN', ns: NAMESPACE })).not.toBe(message);
    }
    expect(
      app.i18n.t(
        'This record or a related record is not available in the current tenant. It may belong to another tenant or have been removed.',
        { lng: 'zh-CN', ns: NAMESPACE },
      ),
    ).toBe('当前租户中无法访问此记录。该记录或关联记录可能属于其他租户，或已被删除。');
    expect(app.i18n.t('Please select a tenant before continuing.', { lng: 'en-US', ns: NAMESPACE })).toBe(
      'Please select a tenant before continuing.',
    );
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
        createdBy: true,
        updatedBy: true,
        fields: [
          {
            type: 'string',
            name: 'title',
          },
        ],
      },
      context: {},
    });

    const collection = app.db.getCollection('tenant_meta_disable_posts');
    expect(collection.getField('tenantId')).toBeTruthy();
    expect(collection.getField('createdBy')).toBeTruthy();
    expect(collection.getField('updatedBy')).toBeTruthy();

    const currentUser = await app.db.getCollection('users').model.create();
    await collection.repository.create({
      values: { title: 'Owned post' },
      context: {
        state: {
          currentUser,
          currentTenant: { id: 'tenant-a' },
        },
      },
    });

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
    expect(collection.getField('tenantId')).toBeFalsy();
    expect(collection.getField('createdBy')).toBeTruthy();
    expect(collection.getField('updatedBy')).toBeTruthy();

    const ownedPost = await collection.repository.findOne({
      filter: {
        createdBy: {
          id: { $eq: currentUser.id },
        },
      },
      appends: ['createdBy'],
    });
    expect(ownedPost?.get('createdBy')?.id).toBe(currentUser.id);

    const table = await app.db.sequelize.getQueryInterface().describeTable('tenant_meta_disable_posts');
    expect(table.tenantId).toBeUndefined();
  });

  it('should expose code-defined tenant collections through collection-manager without overwriting configured tenancy', async () => {
    const name = 'tenant_builtin_configurable_posts';

    app.db.collection({
      name,
      tenancy: 'tenantScoped',
      fields: [
        {
          type: 'string',
          name: 'title',
        },
      ],
    });

    await (app.pm.get('tenant') as any).ensureTenantConfigurableCollectionRecords();

    let collectionModel = await app.db.getRepository('collections').findOne({
      filter: { name },
    });
    expect(collectionModel).toBeTruthy();
    expect(collectionModel.get('tenancy')).toBe('tenantScoped');

    await app.db.getRepository('collections').update({
      filterByTk: name,
      values: {
        tenancy: 'tenantInherited',
      },
      context: {},
    });

    await (app.pm.get('tenant') as any).ensureTenantConfigurableCollectionRecords();

    collectionModel = await app.db.getRepository('collections').findOne({
      filter: { name },
    });
    expect(collectionModel.get('tenancy')).toBe('tenantInherited');
    expect(app.db.getCollection(name).options.tenancy).toBe('tenantInherited');
  });

  it('should not persist code-defined association fields that would be loaded twice', async () => {
    const name = 'tenant_builtin_assoc_posts';

    app.db.collection({
      name,
      tenancy: 'tenantScoped',
      fields: [
        {
          type: 'belongsToMany',
          name: 'executions',
          through: 'approvalExecutions',
          targetKey: 'id',
          sourceKey: 'id',
          foreignKey: 'approvalId',
          otherKey: 'executionId',
        },
        {
          type: 'hasMany',
          name: 'approvalExecutions',
          target: 'approvalExecutions',
        },
      ],
    });

    await (app.pm.get('tenant') as any).ensureTenantConfigurableCollectionRecords();

    const associationField = await app.db.getRepository('fields').findOne({
      filter: {
        collectionName: name,
        name: 'approvalExecutions',
      },
    });
    expect(associationField).toBeFalsy();
    await expect(app.db.getRepository('collections').load({ filter: { name } })).resolves.toBeTruthy();
  });
});
