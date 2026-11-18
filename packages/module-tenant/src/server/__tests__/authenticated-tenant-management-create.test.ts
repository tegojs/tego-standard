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

  it('allows management creation without granting the same write to an impersonation role', async () => {
    app = await createTenantApp();
    const roles = ['tenant-create-manager', 'tenant-create-impersonator'];
    await app.db.getRepository('roles').create({
      values: [
        { name: roles[0], strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
        { name: roles[1], strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
      ],
    });
    await app.db.getRepository('tenants').create({
      values: { id: 'existing-tenant', name: 'Existing tenant', enabled: true },
    });
    const password = 'tenant-create-manager-password';
    const user = await app.db.getRepository('users').create({
      values: { username: roles[0], password, roles },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: user.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user.id).toBe(user.id);
    const asRole = (role: string) =>
      app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role);
    const readTenants = () => app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
    const before = await readTenants();

    const available = await asRole(roles[1]).resource('tenants').available({});
    expect(available.status).toBe(200);
    expect(available.body.data.map(({ id }) => id)).toEqual(['existing-tenant']);
    const values = { id: 'managed-tenant', name: 'Managed tenant', enabled: true };
    const denied = await asRole(roles[1]).resource('tenants').create({ values });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await readTenants()).toEqual(before);

    const created = await asRole(roles[0]).resource('tenants').create({ values });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ ...values, parentId: null, path: '/managed-tenant/' });
    const after = await readTenants();
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter(({ id }) => id !== values.id)).toEqual(before);
    expect(after.find(({ id }) => id === values.id)).toMatchObject({
      ...values,
      enabled: 1,
      parentId: null,
      path: '/managed-tenant/',
    });
    expect(await app.db.getRepository('tenantUsers').count({ filter: { userId: user.id } })).toBe(0);
  });
});
