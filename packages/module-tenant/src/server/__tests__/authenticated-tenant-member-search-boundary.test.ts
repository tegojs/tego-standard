import { createTenantApp } from './utils';

describe('authenticated tenant member search boundary', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not let an impersonator search users through tenant management', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: { id: 'search-tenant', name: 'Search tenant' } });
    const role = 'member-search-impersonator';
    const password = 'member-search-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
    });
    await app.db.getRepository('users').create({
      values: {
        username: 'search-target-user',
        email: 'search-target@example.com',
        password,
        roles: [],
        tenants: ['search-tenant'],
        defaultTenantId: 'search-tenant',
      },
    });
    const impersonator = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role] },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: impersonator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const result = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('users')
      .list({ appends: ['tenants', 'defaultTenant'], filter: { 'tenants.id': 'search-tenant' } });

    expect(result.status).toBe(403);
    expect(result.body).not.toHaveProperty('data');
    expect(await app.db.getRepository('tenantUsers').count({ filter: { tenantId: 'search-tenant' } })).toBe(1);
  });
});
