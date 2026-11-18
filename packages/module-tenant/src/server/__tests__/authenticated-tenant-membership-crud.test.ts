import type { MockServer } from '@tachybase/test';

import { createTenantApp } from './utils';

describe('authenticated tenant membership access boundary', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not let an ordinary tenant member change or remove membership directly', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').createMany({
      records: [
        { id: 'B', name: 'B', enabled: true },
        { id: 'C', name: 'C', enabled: true },
      ],
    });

    const role = 'ordinary-tenant-member';
    const password = 'ordinary-tenant-member-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: 'ordinary-tenant-member',
        email: 'ordinary-tenant-member@example.com',
        phone: '10000000047',
        password,
        roles: [role],
        tenants: ['B'],
        defaultTenantId: 'B',
      },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: 'ordinary-tenant-member',
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: user.id, hasPassword: true });

    const current = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const readMemberships = async () =>
      (await app.db.getCollection('tenantUsers').model.findAll({ raw: true, order: [['tenantId', 'ASC']] })).map(
        ({ tenantId, userId }) => ({ tenantId, userId }),
      );
    const originalMemberships = await readMemberships();
    expect(originalMemberships).toEqual([{ tenantId: 'B', userId: user.id }]);

    const list = await current().resource('tenantUsers').list({});
    const update = await current()
      .resource('tenantUsers')
      .update({
        filter: { userId: user.id, tenantId: 'B' },
        values: { tenantId: 'C' },
      });
    const destroy = await current()
      .resource('tenantUsers')
      .destroy({
        filter: { userId: user.id, tenantId: 'B' },
      });

    expect(list.status).toBe(403);
    expect(list.body).not.toHaveProperty('data');
    expect(update.status).toBe(403);
    expect(update.body).not.toHaveProperty('data');
    expect(destroy.status).toBe(403);
    expect(destroy.body).not.toHaveProperty('data');
    expect(await readMemberships()).toEqual(originalMemberships);
  });

  it('lets a manager add membership through the management API and exposes it to the member', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'B', name: 'Member tenant', enabled: true },
        { id: 'C', name: 'Added tenant', enabled: true },
        { id: 'D', name: 'Unrelated tenant', enabled: true },
      ],
    });
    const memberRole = 'membership-api-member';
    const managerRole = 'membership-api-manager';
    await app.db.getRepository('roles').create({
      values: [
        { name: memberRole, strategy: { actions: [] }, snippets: [] },
        { name: managerRole, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
      ],
    });
    const password = 'membership-api-password';
    const member = await app.db.getRepository('users').create({
      values: { username: memberRole, password, roles: [memberRole], tenants: ['B'], defaultTenantId: 'B' },
    });
    const unrelatedUser = await app.db.getRepository('users').create({
      values: {
        username: 'membership-api-unrelated',
        password,
        roles: [memberRole],
        tenants: ['D'],
        defaultTenantId: 'D',
      },
    });
    const manager = await app.db.getRepository('users').create({
      values: { username: managerRole, password, roles: [managerRole] },
    });
    const login = async (username: string) => {
      const response = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: username,
        password,
      });
      expect(response.status).toBe(200);
      return app
        .agent()
        .set('Authorization', `Bearer ${response.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', username);
    };
    const memberAgent = await login(member.username);
    const managerAgent = await login(manager.username);
    const readMemberships = () =>
      app.db
        .getRepository('tenantUsers')
        .find({ fields: ['tenantId', 'userId'], sort: ['tenantId', 'userId'], raw: true });
    expect(await readMemberships()).toEqual([
      { tenantId: 'B', userId: member.id },
      { tenantId: 'D', userId: unrelatedUser.id },
    ]);
    const originalTenants = await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
    const originalUsers = await app.db.getCollection('users').model.findAll({ raw: true, order: [['id', 'ASC']] });
    const before = await memberAgent.resource('tenants').available({});
    expect(before.status).toBe(200);
    expect(before.body.data.map(({ id }) => id)).toEqual(['B']);

    const values = { tenantId: 'C', userId: member.id };
    const denied = await memberAgent.resource('tenantUsers').create({ values });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await readMemberships()).toEqual([
      { tenantId: 'B', userId: member.id },
      { tenantId: 'D', userId: unrelatedUser.id },
    ]);

    const added = await managerAgent.resource('tenantUsers').create({ values });
    expect(added.status).toBe(200);
    expect(added.body.data).toMatchObject(values);
    expect(await readMemberships()).toEqual([
      { tenantId: 'B', userId: member.id },
      { tenantId: 'C', userId: member.id },
      { tenantId: 'D', userId: unrelatedUser.id },
    ]);
    const after = await memberAgent.resource('tenants').available({});
    expect(after.status).toBe(200);
    expect(after.body.data.map(({ id }) => id)).toEqual(['B', 'C']);
    expect(after.body.data.filter(({ current }) => current).map(({ id }) => id)).toEqual(['B']);
    const tenantMemberList = await managerAgent.resource('users').list({
      page: 1,
      pageSize: 20,
      appends: ['tenants', 'defaultTenant'],
      filter: { 'tenants.id': 'C' },
    });
    expect(tenantMemberList.status).toBe(200);
    expect(tenantMemberList.body.data.map(({ id }) => id)).toEqual([member.id]);
    expect(tenantMemberList.body.data[0].tenants.map(({ id }) => id)).toEqual(['B', 'C']);
    expect(tenantMemberList.body.data.map(({ id }) => id)).not.toContain(unrelatedUser.id);
    expect(await app.db.getCollection('users').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      originalUsers,
    );
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      originalTenants,
    );
    expect(await app.db.getRepository('tenantUsers').count({ filter: { userId: manager.id } })).toBe(0);
  });

  it('lets a manager remove membership and stops exposing the removed tenant to the member', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'B', name: 'Member tenant', enabled: true },
        { id: 'C', name: 'Removed tenant', enabled: true },
      ],
    });
    const memberRole = 'membership-remove-member';
    const managerRole = 'membership-remove-manager';
    await app.db.getRepository('roles').create({
      values: [
        { name: memberRole, strategy: { actions: [] }, snippets: [] },
        { name: managerRole, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
      ],
    });
    const password = 'membership-remove-password';
    const member = await app.db.getRepository('users').create({
      values: { username: memberRole, password, roles: [memberRole], tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const manager = await app.db.getRepository('users').create({
      values: { username: managerRole, password, roles: [managerRole] },
    });
    const login = async (username: string) => {
      const response = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: username,
        password,
      });
      expect(response.status).toBe(200);
      return app
        .agent()
        .set('Authorization', `Bearer ${response.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', username);
    };
    const memberAgent = await login(member.username);
    const managerAgent = await login(manager.username);
    const readMemberships = () =>
      app.db
        .getRepository('tenantUsers')
        .find({ fields: ['tenantId', 'userId'], sort: ['tenantId', 'userId'], raw: true });
    const originalTenants = await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await readMemberships()).toEqual([
      { tenantId: 'B', userId: member.id },
      { tenantId: 'C', userId: member.id },
    ]);

    const before = await memberAgent.resource('tenants').available({});
    expect(before.status).toBe(200);
    expect(before.body.data.map(({ id }) => id)).toEqual(['B', 'C']);
    const removed = await managerAgent.resource('tenantUsers').destroy({
      filter: { tenantId: 'C', userId: member.id },
    });

    expect(removed.status).toBe(200);
    expect(removed.body).toHaveProperty('data');
    expect(await readMemberships()).toEqual([{ tenantId: 'B', userId: member.id }]);
    const after = await memberAgent.resource('tenants').available({});
    expect(after.status).toBe(200);
    expect(after.body.data.map(({ id }) => id)).toEqual(['B']);
    expect(after.body.data.filter(({ current }) => current).map(({ id }) => id)).toEqual(['B']);
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      originalTenants,
    );
    expect(
      await app.db
        .getCollection('users')
        .model.findByPk(member.id)
        .then((record) => record?.get('defaultTenantId')),
    ).toBe('B');
  });
});
