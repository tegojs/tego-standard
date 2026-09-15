import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('tenant association source writes', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([false, true])(
    'does not let a readable legacy source change its associations before a claim (editing: %s)',
    async (allowEditingLegacyData) => {
      app = await createTenantApp();
      await app.db.getRepository('tenants').create({ values: [{ id: 'tenant-a', name: 'Tenant A' }] });
      const user = await app.db.getRepository('users').create({
        values: {
          username: 'tenant_readonly_association_source',
          email: 'tenant-readonly-association-source@example.com',
          password: '123456',
          roles: ['root'],
          tenants: ['tenant-a'],
          defaultTenantId: 'tenant-a',
        },
      });
      await app.db.getRepository('collections').create({
        values: { name: 'tenant_shared_assoc_targets', tenancy: 'shared', fields: [{ type: 'string', name: 'title' }] },
        context: {},
      });
      await app.db.getRepository('collections').create({
        values: {
          name: 'tenant_readonly_assoc_sources',
          tenancy: 'tenantScoped',
          legacyDataTenantIds: ['tenant-a'],
          allowEditingLegacyData,
          fields: [
            { type: 'string', name: 'title' },
            { type: 'belongsToMany', name: 'targets', target: 'tenant_shared_assoc_targets' },
          ],
        },
        context: {},
      });
      const source = await app.db
        .getRepository('tenant_readonly_assoc_sources')
        .create({ values: { title: 'Legacy' } });
      const target = await app.db.getRepository('tenant_shared_assoc_targets').create({ values: { title: 'Shared' } });
      const agent = app.agent().login(user).set('X-Locale', 'zh-CN');

      const readable = await agent.resource('tenant_readonly_assoc_sources.targets', source.get('id')).list({});
      const response = await agent.resource('tenant_readonly_assoc_sources.targets', source.get('id')).add({
        values: [target.get('id')],
      });

      expect(readable.status).toBe(200);
      expect(response.status).toBe(403);
      if (allowEditingLegacyData) {
        expect(response.body.errors?.[0]?.message).toBe(
          '该记录尚未归属租户，请先编辑记录，将其归属到当前租户后再修改关联。',
        );
      }
      expect(await app.db.getRepository('tenant_readonly_assoc_sources.targets', source.get('id')).count()).toBe(0);
      await source.reload();
      expect(source.get('tenantId')).toBeNull();
    },
  );

  it('does not expose a tenant-owned relation through its independent join-table resource', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'Tenant A' },
        { id: 'tenant-b', name: 'Tenant B' },
      ],
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_join_table_reader',
        email: 'tenant-join-table-reader@example.com',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_join_edges',
        fields: [
          { type: 'integer', name: 'source_id' },
          { type: 'integer', name: 'target_id' },
        ],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: { name: 'tenant_join_targets', tenancy: 'shared', fields: [{ type: 'string', name: 'title' }] },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_join_sources',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          {
            type: 'belongsToMany',
            name: 'targets',
            target: 'tenant_join_targets',
            through: 'tenant_join_edges',
            foreignKey: 'source_id',
            otherKey: 'target_id',
          },
        ],
      },
      context: {},
    });
    const source = await app.db.getRepository('tenant_join_sources').create({
      values: { title: 'Foreign source' },
      context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
    });
    const target = await app.db.getRepository('tenant_join_targets').create({ values: { title: 'Shared target' } });
    await app.db.getRepository('tenant_join_sources.targets', source.get('id')).add([target.get('id')]);

    const response = await app.agent().login(user).resource('tenant_join_edges').list({});

    expect(response.status).toBe(403);
    expect(await app.db.getRepository('tenant_join_edges').count()).toBe(1);
  });

  it('does not expose the join table when the source is shared and the target is tenant-owned', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'Tenant A' },
        { id: 'tenant-b', name: 'Tenant B' },
      ],
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_inverse_join_reader',
        email: 'tenant-inverse-join-reader@example.com',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_inverse_join_edges',
        fields: [
          { type: 'integer', name: 'source_id' },
          { type: 'integer', name: 'target_id' },
        ],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: { name: 'tenant_inverse_join_targets', tenancy: 'tenantScoped' },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_inverse_join_sources',
        tenancy: 'shared',
        fields: [
          {
            type: 'belongsToMany',
            name: 'targets',
            target: 'tenant_inverse_join_targets',
            through: 'tenant_inverse_join_edges',
            foreignKey: 'source_id',
            otherKey: 'target_id',
          },
        ],
      },
      context: {},
    });
    const source = await app.db.getRepository('tenant_inverse_join_sources').create({ values: {} });
    const target = await app.db.getRepository('tenant_inverse_join_targets').create({
      values: {},
      context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
    });
    await app.db.getRepository('tenant_inverse_join_sources.targets', source.get('id')).add([target.get('id')]);

    const agent = app.agent().login(user);
    const response = await agent.resource('tenant_inverse_join_edges').list({});
    const writeResponse = await agent.resource('tenant_inverse_join_edges').create({
      values: { source_id: source.get('id'), target_id: target.get('id') },
    });

    expect(response.status).toBe(403);
    expect(writeResponse.status).toBe(403);
    expect(await app.db.getRepository('tenant_inverse_join_edges').count()).toBe(1);
  });

  it('leaves a join table accessible when both sides are shared', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: [{ id: 'tenant-a', name: 'Tenant A' }] });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_shared_join_reader',
        email: 'tenant-shared-join-reader@example.com',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'shared_join_edges',
        fields: [
          { type: 'integer', name: 'source_id' },
          { type: 'integer', name: 'target_id' },
        ],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: { name: 'shared_join_targets', tenancy: 'shared' },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'shared_join_sources',
        tenancy: 'shared',
        fields: [
          {
            type: 'belongsToMany',
            name: 'targets',
            target: 'shared_join_targets',
            through: 'shared_join_edges',
            foreignKey: 'source_id',
            otherKey: 'target_id',
          },
        ],
      },
      context: {},
    });

    const agent = app.agent().login(user);
    const response = await agent.resource('shared_join_edges').list({});

    expect(response.status).toBe(200);

    await app.db.getRepository('collections').update({
      filterByTk: 'shared_join_targets',
      values: { tenancy: 'tenantScoped' },
      context: {},
    });
    const restrictedResponse = await agent.resource('shared_join_edges').list({});
    expect(restrictedResponse.status).toBe(403);
  });

  it('enforces the source update scope when a role can call the association add action', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: [{ id: 'tenant-a', name: 'Tenant A' }] });
    await app.db.getRepository('collections').create({
      values: { name: 'tenant_acl_targets', tenancy: 'shared', fields: [{ type: 'string', name: 'title' }] },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_acl_sources',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'integer', name: 'createdById' },
          { type: 'belongsToMany', name: 'targets', target: 'tenant_acl_targets' },
        ],
      },
      context: {},
    });
    const source = await app.db.getRepository('tenant_acl_sources').create({
      values: { title: 'Tenant A' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    const target = await app.db.getRepository('tenant_acl_targets').create({ values: { title: 'Shared' } });
    await app.db.getRepository('roles').create({ values: { name: 'tenant_relation_only' } });
    const role = app.acl.getRole('tenant_relation_only');
    role.grantAction('tenant_acl_sources:view');
    role.grantAction('tenant_acl_sources:add');
    role.grantAction('tenant_acl_sources.targets:add');
    role.grantAction('tenant_acl_targets:update');
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_acl_relation_only',
        email: 'tenant-acl-relation-only@example.com',
        password: '123456',
        roles: ['tenant_relation_only'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    role.grantAction('tenant_acl_sources:update', { filter: { createdById: user.get('id') } });
    const ownSource = await app.db.getRepository('tenant_acl_sources').create({
      values: { title: 'Owned by caller', createdById: user.get('id') },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });

    expect(
      app.acl.can({ role: 'tenant_relation_only', resource: 'tenant_acl_sources.targets', action: 'add' }),
    ).not.toBeNull();
    expect(
      app.acl.can({ role: 'tenant_relation_only', resource: 'tenant_acl_sources', action: 'update' }),
    ).not.toBeNull();

    const agent = app.agent().login(user);
    const allowedResponse = await agent.resource('tenant_acl_sources.targets', ownSource.get('id')).add({
      values: [target.get('id')],
    });
    const response = await agent.resource('tenant_acl_sources.targets', source.get('id')).add({
      values: [target.get('id')],
    });

    expect(allowedResponse.status, JSON.stringify(allowedResponse.body)).toBe(200);
    expect(await app.db.getRepository('tenant_acl_sources.targets', ownSource.get('id')).count()).toBe(1);
    expect(response.status).toBe(403);
    expect(await app.db.getRepository('tenant_acl_sources.targets', source.get('id')).count()).toBe(0);
  });

  it('does not attach a read-only legacy target through a shared has-many source', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: [{ id: 'tenant-a', name: 'Tenant A' }] });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_reverse_legacy_writer',
        email: 'tenant-reverse-legacy-writer@example.com',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    await app.db.getRepository('collections').create({
      values: { name: 'tenant_reverse_projects', tenancy: 'tenantScoped', legacyDataTenantIds: ['tenant-a'] },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_reverse_companies',
        tenancy: 'shared',
        fields: [{ type: 'hasMany', name: 'projects', target: 'tenant_reverse_projects' }],
      },
      context: {},
    });
    const company = await app.db.getRepository('tenant_reverse_companies').create({ values: {} });
    const project = await app.db.getRepository('tenant_reverse_projects').create({ values: {} });
    const foreignKey = app.db.getCollection('tenant_reverse_companies').model.associations.projects.foreignKey;

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_reverse_companies.projects', company.get('id'))
      .add({
        values: [project.get('id')],
      });

    expect(response.status).toBe(403);
    await project.reload();
    expect(project.get('tenantId')).toBeNull();
    expect(project.get(foreignKey)).toBeNull();
  });

  it('does not detach a read-only legacy target when a shared has-many source is set to empty', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: [{ id: 'tenant-a', name: 'Tenant A' }] });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_reverse_legacy_detach',
        email: 'tenant-reverse-legacy-detach@example.com',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    await app.db.getRepository('collections').create({
      values: { name: 'tenant_reverse_set_projects', tenancy: 'tenantScoped', legacyDataTenantIds: ['tenant-a'] },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'tenant_reverse_set_companies',
        tenancy: 'shared',
        fields: [{ type: 'hasMany', name: 'projects', target: 'tenant_reverse_set_projects' }],
      },
      context: {},
    });
    const company = await app.db.getRepository('tenant_reverse_set_companies').create({ values: {} });
    const foreignKey = app.db.getCollection('tenant_reverse_set_companies').model.associations.projects.foreignKey;
    const project = await app.db.getRepository('tenant_reverse_set_projects').create({
      values: { [foreignKey]: company.get('id') },
    });

    const response = await app
      .agent()
      .login(user)
      .resource('tenant_reverse_set_companies.projects', company.get('id'))
      .set({
        values: [],
      });

    expect(response.status).toBe(403);
    await project.reload();
    expect(project.get('tenantId')).toBeNull();
    expect(project.get(foreignKey)).toBe(company.get('id'));
  });
});
