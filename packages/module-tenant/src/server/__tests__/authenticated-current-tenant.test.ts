import { createTenantApp } from './utils';

describe('authenticated current tenant lookup', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('requires login and exposes only the current member tenant public fields', async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'current-member', name: 'Member tenant', enabled: true },
        { id: 'current-unrelated', name: 'Unrelated tenant', enabled: true },
      ],
    });
    const role = 'current-tenant-basic-user';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: [] },
    });
    const password = 'current-tenant-basic-password';
    const user = await app.db.getRepository('users').create({
      values: {
        username: role,
        password,
        roles: [role],
        tenants: ['current-member'],
        defaultTenantId: 'current-member',
      },
    });

    const unauthenticated = await app.agent().resource('tenants').current({});
    expect(unauthenticated.status).toBe(401);

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
      .current({});

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: 'current-member', name: 'Member tenant' });
    expect(
      await app.db.getRepository('tenantUsers').find({ filter: { userId: user.id }, fields: ['tenantId'], raw: true }),
    ).toEqual([{ tenantId: 'current-member' }]);
  });
});
