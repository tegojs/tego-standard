import type { MockServer } from '@tachybase/test';

import { resolveAssociationReadScope } from '../helpers/association-read-scope';
import { createTenantApp } from './utils';

describe('shared-source association read boundaries', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  async function setup() {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-a', name: 'Tenant A' },
        { id: 'tenant-b', name: 'Tenant B' },
      ],
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'association_reader',
        email: 'association-reader@example.com',
        password: '123456',
        roles: ['root'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'read_info',
        tenancy: 'shared',
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'read_projects',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'belongsTo', name: 'info', target: 'read_info' },
        ],
      },
      context: {},
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'read_companies',
        tenancy: 'shared',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'belongsToMany', name: 'projects', target: 'read_projects' },
          { type: 'belongsTo', name: 'info', target: 'read_info' },
        ],
      },
      context: {},
    });
    const info = await app.db.getRepository('read_info').create({ values: { title: 'Shared info' } });
    const company = await app.db.getRepository('read_companies').create({
      values: { title: 'Shared company', infoId: info.get('id') },
    });
    const repo = app.db.getRepository('read_projects');
    const own = await repo.create({
      values: { title: 'Tenant A project' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    const foreign = await repo.create({
      values: { title: 'Tenant B project' },
      context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
    });
    const projectInfoKey = app.db.getCollection('read_projects').model.associations.info.foreignKey;
    await repo.update({ filterByTk: own.get('id'), values: { [projectInfoKey]: info.get('id') } });
    await app.db.getRepository('read_companies.projects', company.get('id')).add([own.get('id'), foreign.get('id')]);
    return { agent: app.agent().login(user), company, own, foreign };
  }

  it('fails closed on old-core scoped appends and filters them on a capable core', async () => {
    const { agent, company, own } = await setup();
    const shared = await agent.resource('read_companies').get({ filterByTk: company.get('id'), appends: ['info'] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.data).toBeDefined();
    const scoped = await agent.resource('read_companies').get({ filterByTk: company.get('id'), appends: ['projects'] });
    if ((app.db.getRepository('read_companies') as any).supportsAssociationReadScope === true) {
      expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
      expect(scoped.body.data.projects.map((project: any) => project.id)).toEqual([own.get('id')]);
    } else {
      expect(scoped.status, JSON.stringify(scoped.body)).toBe(403);
    }
  });

  it('scopes direct association list, count and get to the target tenant', async () => {
    const { agent, company, own, foreign } = await setup();
    const list = await agent.resource('read_companies.projects', company.get('id')).list({});
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.map((row: any) => row.id)).toEqual([own.get('id')]);
    expect(list.body.meta.count).toBe(1);
    const get = await agent
      .resource('read_companies.projects', company.get('id'))
      .get({ filterByTk: foreign.get('id') });
    expect(get.body.data ?? null).toBeNull();
  });

  it('keeps collection field metadata readable without a separate fields data permission', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: { id: 'tenant-a', name: 'Tenant A' } });
    await app.db.getRepository('collections').create({
      values: { name: 'metadata_projects', fields: [{ name: 'title', type: 'string', interface: 'input' }] },
      context: {},
    });
    await app.db.getRepository('roles').create({ values: { name: 'metadata_reader' } });
    const role = app.acl.getRole('metadata_reader');
    role.grantAction('collections:view');
    role.grantAction('collections.fields:list');
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'metadata_reader',
        email: 'metadata-reader@example.com',
        password: '123456',
        roles: ['metadata_reader'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    const agent = app.agent().login(user);
    const response = await agent.resource('collections').list({
      paginate: false,
      appends: ['fields'],
      filter: { name: 'metadata_projects' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data[0].fields.map((field: any) => field.name)).toContain('title');
    role.grantAction('fields:list');
    const directFields = await agent.resource('collections.fields', 'metadata_projects').list({ paginate: false });
    expect(directFields.status, JSON.stringify(directFields.body)).toBe(200);
    expect(directFields.body.data.map((field: any) => field.name)).toContain('title');
  });

  it('does not exempt same-named fields in another data source', async () => {
    app = await createTenantApp();
    const externalFields = { name: 'fields', model: { primaryKeyAttribute: 'id' } };
    const ctx = {
      tego: { db: app.db },
      action: { resourceName: 'collections' },
      can: () => null,
    };
    const scope = await resolveAssociationReadScope(ctx, externalFields, { source: { name: 'collections' } }, app.acl);
    expect(scope).toEqual({ filter: { id: { $in: [] } }, fields: [], appends: [] });
  });

  it('enforces target row-level ACL on direct association list and count', async () => {
    const { company } = await setup();
    const extra = await app.db.getRepository('read_projects').create({
      values: { title: 'Hidden tenant A project' },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });
    await app.db.getRepository('read_companies.projects', company.get('id')).add(extra.get('id'));
    await app.db.getRepository('roles').create({ values: { name: 'scoped_relation_reader' } });
    const role = app.acl.getRole('scoped_relation_reader');
    role.grantAction('read_companies:view');
    role.grantAction('read_companies.projects:list');
    role.grantAction('read_projects:view', { filter: { title: 'Tenant A project' } });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'scoped_relation_reader',
        email: 'scoped-relation-reader@example.com',
        password: '123456',
        roles: ['scoped_relation_reader'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    const response = await app.agent().login(user).resource('read_companies.projects', company.get('id')).list({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.map((row: any) => row.title)).toEqual(['Tenant A project']);
    expect(response.body.meta.count).toBe(1);
  });

  it('requires the source view scope for plural and singular association reads', async () => {
    const { company, own } = await setup();
    const hidden = await app.db.getRepository('read_companies').create({ values: { title: 'Hidden company' } });
    const info = await app.db.getRepository('read_info').create({ values: { title: 'Hidden info' } });
    await app.db
      .getRepository('read_companies')
      .update({ filterByTk: hidden.get('id'), values: { infoId: info.get('id') } });
    await app.db.getRepository('read_companies.projects', hidden.get('id')).add(own.get('id'));

    await app.db.getRepository('roles').create({ values: { name: 'source_scoped_reader' } });
    const role = app.acl.getRole('source_scoped_reader');
    role.grantAction('read_companies:view', { filter: { title: 'Shared company' } });
    role.grantAction('read_companies.projects:list');
    role.grantAction('read_companies.projects:get');
    role.grantAction('read_companies.info:get');
    role.grantAction('read_projects:view');
    role.grantAction('read_info:view');
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'source_scoped_reader',
        email: 'source-scoped-reader@example.com',
        password: '123456',
        roles: ['source_scoped_reader'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });
    const agent = app.agent().login(user);

    const direct = await agent.resource('read_companies').get({ filterByTk: hidden.get('id') });
    expect(direct.status).toBe(200);
    expect(direct.body.data ?? null).toBeNull();

    const sourceRepository = app.db.getCollection('read_companies').repository;
    const sourceFindOne = vi.spyOn(sourceRepository, 'findOne');
    const allowed = await agent.resource('read_companies.projects', company.get('id')).list({});
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.data.map((row: any) => row.id)).toEqual([own.get('id')]);
    expect(sourceFindOne).toHaveBeenCalledTimes(2);
    sourceFindOne.mockRestore();

    for (const response of [
      await agent.resource('read_companies.projects', hidden.get('id')).list({}),
      await agent.resource('read_companies.projects', hidden.get('id')).get({ filterByTk: own.get('id') }),
      await agent.resource('read_companies.info', hidden.get('id')).get({ filterByTk: info.get('id') }),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
    }
  });

  it('does not allow direct association appends omitted by the target ACL', async () => {
    const { company } = await setup();
    await app.db.getRepository('roles').create({ values: { name: 'no_nested_relation_reader' } });
    const role = app.acl.getRole('no_nested_relation_reader');
    role.grantAction('read_companies:view');
    role.grantAction('read_companies.projects:list');
    role.grantAction('read_projects:view', { appends: [] });
    role.grantAction('read_info:view');
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'no_nested_relation_reader',
        email: 'no-nested-relation-reader@example.com',
        password: '123456',
        roles: ['no_nested_relation_reader'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    const response = await app
      .agent()
      .login(user)
      .resource('read_companies.projects', company.get('id'))
      .list({
        appends: ['info'],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.every((row: any) => row.info == null)).toBe(true);
  });

  it('fails closed for old-core scoped tree searches and filters them on a capable core', async () => {
    const { agent } = await setup();
    await app.db.getRepository('collections').create({
      values: {
        name: 'read_tree',
        tenancy: 'tenantScoped',
        tree: 'adjacency-list',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'integer', name: 'parentId' },
        ],
      },
      context: {},
    });
    const repo = app.db.getRepository('read_tree');
    const hidden = await repo.create({
      values: { title: 'Hidden parent' },
      context: { state: { currentTenant: { id: 'tenant-b' }, currentTenantId: 'tenant-b' } },
    });
    await repo.create({
      values: { title: 'Matching child', parentId: hidden.get('id') },
      context: { state: { currentTenant: { id: 'tenant-a' }, currentTenantId: 'tenant-a' } },
    });

    const response = await agent.resource('read_tree').list({ tree: true, filter: { title: 'Matching child' } });
    if ((app.resourcer.getRegisteredHandler('list') as any)?.supportsScopedTreeRead === true) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.map((row: any) => row.title)).toEqual(['Matching child']);
      expect(response.body.meta.count).toBe(1);
    } else {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.errors[0].message).toContain('tree');
    }
  });

  it('keeps unrestricted shared tree searches available on the old core', async () => {
    const { agent } = await setup();
    await app.db.getRepository('collections').create({
      values: {
        name: 'shared_read_tree',
        tenancy: 'shared',
        tree: 'adjacency-list',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'integer', name: 'parentId' },
        ],
      },
      context: {},
    });
    const parent = await app.db.getRepository('shared_read_tree').create({ values: { title: 'Parent' } });
    await app.db.getRepository('shared_read_tree').create({
      values: { title: 'Matching child', parentId: parent.get('id') },
    });

    const response = await agent.resource('shared_read_tree').list({ tree: true, filter: { title: 'Matching child' } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data[0].title).toBe('Parent');
  });
});
