import { createTenantApp } from './utils';

describe('authenticated tenant management create boundary', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not let an ordinary tenant member create a tenant', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: { id: 'member-tenant', name: 'Member tenant', enabled: true },
    });
    const role = 'ordinary-tenant-creator';
    const password = 'ordinary-tenant-creator-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: [] },
    });
    const user = await app.db.getRepository('users').create({
      values: {
        username: role,
        password,
        roles: [role],
        tenants: ['member-tenant'],
        defaultTenantId: 'member-tenant',
      },
    });
    const before = await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: user.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('tenants')
      .create({ values: { id: 'unauthorized-tenant', name: 'Unauthorized tenant', enabled: true } });

    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(before);
  });
});
