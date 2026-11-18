import { createTenantApp } from './utils';

describe('authenticated available tenant listing', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('requires a real login and only returns enabled tenants from persisted memberships', async () => {
    app = await createTenantApp();
    const tenants = app.db.getRepository('tenants');
    await tenants.create({
      values: [
        { id: 'available-member', name: 'Member tenant', enabled: true },
        { id: 'available-unrelated', name: 'Unrelated tenant', enabled: true },
        { id: 'available-disabled', name: 'Disabled tenant', enabled: false },
      ],
    });
    const role = 'available-tenant-basic-user';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: [] },
    });
    const password = 'available-tenant-basic-password';
    const user = await app.db.getRepository('users').create({
      values: {
        username: role,
        password,
        roles: [role],
        tenants: ['available-member'],
        defaultTenantId: 'available-member',
      },
    });

    const unauthenticated = await app.agent().resource('tenants').available({});
    expect(unauthenticated.status).toBe(401);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: user.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const collectionList = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('tenants')
      .list({});
    expect(collectionList.status).toBe(403);
    expect(collectionList.body).not.toHaveProperty('data');

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('tenants')
      .available({});

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject([
      {
        id: 'available-member',
        name: 'Member tenant',
        enabled: true,
        current: true,
      },
    ]);
    expect(response.body.data.map(({ id }) => id)).toEqual(['available-member']);
    expect(
      await app.db.getRepository('tenantUsers').find({ filter: { userId: user.id }, fields: ['tenantId'], raw: true }),
    ).toEqual([{ tenantId: 'available-member' }]);
  });
});
