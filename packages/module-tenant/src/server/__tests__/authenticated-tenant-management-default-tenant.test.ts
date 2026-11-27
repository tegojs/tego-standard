import { createTenantApp } from './utils';

describe('authenticated tenant management default tenant boundary', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not let an impersonator rewrite a member default tenant through users:update', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'member-tenant', name: 'Member tenant', enabled: true },
        { id: 'other-tenant', name: 'Other tenant', enabled: true },
      ],
    });

    const roles = ['default-tenant-manager', 'default-tenant-impersonator', 'default-tenant-member'];
    const password = 'default-tenant-password';
    await app.db.getRepository('roles').create({
      values: [
        { name: roles[0], strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
        { name: roles[1], strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
        { name: roles[2], strategy: { actions: [] }, snippets: [] },
      ],
    });
    const member = await app.db.getRepository('users').create({
      values: {
        username: roles[2],
        password,
        roles: [roles[2]],
        tenants: ['member-tenant'],
        defaultTenantId: 'member-tenant',
      },
    });
    const impersonator = await app.db.getRepository('users').create({
      values: { username: roles[1], password, roles: [roles[1]] },
    });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: impersonator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const impersonatorAgent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', roles[1]);

    const before = await app.db.getRepository('users').findOne({ filterByTk: member.id });
    const denied = await impersonatorAgent.resource('users').update({
      filterByTk: member.id,
      values: { defaultTenantId: 'other-tenant' },
    });

    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await app.db.getRepository('users').findOne({ filterByTk: member.id })).toMatchObject({
      id: before.get('id'),
      defaultTenantId: 'member-tenant',
    });
    expect(await app.db.getRepository('tenantUsers').find({ filter: { userId: member.id }, raw: true })).toEqual([
      expect.objectContaining({ tenantId: 'member-tenant', userId: member.id }),
    ]);
  });
});
