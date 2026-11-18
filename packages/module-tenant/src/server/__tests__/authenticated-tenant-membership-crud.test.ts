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
    const changedDefault = await managerAgent.resource('users').update({
      filterByTk: member.id,
      values: { defaultTenantId: 'D' },
    });
    expect(changedDefault.status).toBe(200);
    expect((await app.db.getRepository('users').findOne({ filterByTk: member.id })).get('defaultTenantId')).toBe('D');
    const afterInaccessibleDefault = await memberAgent.resource('tenants').available({});
    expect(afterInaccessibleDefault.status).toBe(200);
    expect(afterInaccessibleDefault.body.data.map(({ id }) => id)).toEqual(['B', 'C']);
    expect(afterInaccessibleDefault.body.data.filter(({ current }) => current).map(({ id }) => id)).toEqual(['B']);
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
    const usersAfterDefaultChange = await app.db
      .getCollection('users')
      .model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(usersAfterDefaultChange.filter(({ id }) => id !== member.id)).toEqual(
      originalUsers.filter(({ id }) => id !== member.id),
    );
    expect(usersAfterDefaultChange.find(({ id }) => id === member.id)).toMatchObject({
      id: member.id,
      username: member.username,
      defaultTenantId: 'D',
      updatedById: manager.id,
    });
    const memberBeforeDefaultChange = originalUsers.find(({ id }) => id === member.id);
    expect(usersAfterDefaultChange.find(({ id }) => id === member.id)).toMatchObject({
      email: memberBeforeDefaultChange.email,
      phone: memberBeforeDefaultChange.phone,
      status: memberBeforeDefaultChange.status,
    });
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      originalTenants,
    );
    expect(await app.db.getRepository('tenantUsers').count({ filter: { userId: manager.id } })).toBe(0);
  });

  it('denies direct business access in a tenant after the member is removed', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'B', name: 'Member tenant', enabled: true },
        { id: 'C', name: 'Removed tenant', enabled: true },
      ],
    });
    const businessName = 'membershipRevocationRecords';
    await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: businessName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'value', type: 'string' }],
      },
    });
    const memberRole = 'membership-remove-member';
    const managerRole = 'membership-remove-manager';
    await app.db.getRepository('roles').create({
      values: [
        { name: memberRole, strategy: { actions: [] }, snippets: [] },
        { name: managerRole, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
      ],
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: memberRole,
        name: businessName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['value'] },
          { name: 'list', fields: ['tenantId', 'value'] },
          { name: 'update', fields: ['value'] },
        ],
      },
    });
    const password = 'membership-remove-password';
    const member = await app.db.getRepository('users').create({
      values: { username: memberRole, password, roles: [memberRole], tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const manager = await app.db.getRepository('users').create({
      values: { username: managerRole, password, roles: [managerRole] },
    });
    await app.db.getCollection(businessName).model.bulkCreate([
      { value: 'B record', tenantId: 'B' },
      { value: 'C record', tenantId: 'C' },
    ]);
    const login = async (username: string) => {
      const response = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: username,
        password,
      });
      expect(response.status).toBe(200);
      return {
        token: response.body.data.token,
        agent: app
          .agent()
          .set('Authorization', `Bearer ${response.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', username),
      };
    };
    const { agent: memberAgent, token: memberToken } = await login(member.username);
    const { agent: managerAgent } = await login(manager.username);
    const memberInC = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${memberToken}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', memberRole)
        .set('X-Tenant-Id', 'C')
        .resource(businessName);
    const readBusinessRows = () =>
      app.db.getCollection(businessName).model.findAll({ raw: true, order: [['id', 'ASC']] });
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
    const selected = await memberAgent.resource('tenants').switch({ values: { tenantId: 'C' } });
    expect(selected.status).toBe(200);
    expect(selected.body.data).toMatchObject({ id: 'C', name: 'Removed tenant' });
    expect((await app.db.getRepository('users').findOne({ filterByTk: member.id })).get('defaultTenantId')).toBe('C');
    const beforeRemoval = await memberInC().list({ fields: ['tenantId', 'value'] });
    expect(beforeRemoval.status).toBe(200);
    expect(beforeRemoval.body.data).toEqual([{ tenantId: 'C', value: 'C record' }]);
    const createdBeforeRemoval = await memberInC().create({ values: { value: 'C created before removal' } });
    expect(createdBeforeRemoval.status).toBe(200);
    expect(createdBeforeRemoval.body.data).toEqual({
      id: 3,
      tenantId: 'C',
      value: 'C created before removal',
    });
    const updatedBeforeRemoval = await memberInC().update({
      filterByTk: 2,
      values: { value: 'C updated before removal' },
    });
    expect(updatedBeforeRemoval.status).toBe(200);
    const businessRowsBeforeRemoval = [
      { id: 1, value: 'B record', tenantId: 'B' },
      { id: 2, value: 'C updated before removal', tenantId: 'C' },
      { id: 3, value: 'C created before removal', tenantId: 'C' },
    ];
    expect(await readBusinessRows()).toEqual(businessRowsBeforeRemoval);
    const removed = await managerAgent.resource('tenantUsers').destroy({
      filter: { tenantId: 'C', userId: member.id },
    });

    expect(removed.status).toBe(200);
    expect(removed.body).toHaveProperty('data');
    expect(await readMemberships()).toEqual([{ tenantId: 'B', userId: member.id }]);
    const deniedBusinessRead = await memberInC().list({ fields: ['tenantId', 'value'] });
    expect(deniedBusinessRead.status).toBe(403);
    expect(deniedBusinessRead.body).not.toHaveProperty('data');
    const deniedBusinessCreate = await memberInC().create({ values: { value: 'C created after removal' } });
    expect(deniedBusinessCreate.status).toBe(403);
    expect(deniedBusinessCreate.body).not.toHaveProperty('data');
    const deniedBusinessUpdate = await memberInC().update({
      filterByTk: 2,
      values: { value: 'C updated after removal' },
    });
    expect(deniedBusinessUpdate.status).toBe(403);
    expect(deniedBusinessUpdate.body).not.toHaveProperty('data');
    expect(await readBusinessRows()).toEqual(businessRowsBeforeRemoval);
    const staleSwitch = await memberAgent.resource('tenants').switch({ values: { tenantId: 'C' } });
    expect(staleSwitch.status).toBe(403);
    expect(staleSwitch.body).not.toHaveProperty('data');
    expect((await app.db.getRepository('users').findOne({ filterByTk: member.id })).get('defaultTenantId')).toBe('C');
    const after = await memberAgent.resource('tenants').available({});
    expect(after.status).toBe(200);
    expect(after.body.data.map(({ id }) => id)).toEqual(['B']);
    expect(after.body.data.filter(({ current }) => current).map(({ id }) => id)).toEqual(['B']);
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      originalTenants,
    );
  });
});
