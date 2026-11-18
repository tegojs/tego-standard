import { createTenantApp } from './utils';

describe('authenticated tenant management update boundary', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('allows managers to update a tenant without granting the write to impersonators', async () => {
    app = await createTenantApp();
    const roles = ['tenant-update-manager', 'tenant-update-impersonator'];
    await app.db.getRepository('roles').create({
      values: [
        { name: roles[0], strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
        { name: roles[1], strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
      ],
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'managed-tenant', name: 'Managed tenant', enabled: true, path: '/managed-tenant/' },
        { id: 'control-tenant', name: 'Control tenant', enabled: true, path: '/control-tenant/' },
      ],
    });
    const password = 'tenant-update-manager-password';
    const user = await app.db.getRepository('users').create({
      values: { username: roles[0], password, roles },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: user.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const asRole = (role: string) =>
      app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role);
    const readTenants = () => app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
    const before = await readTenants();
    const values = { name: 'Managed tenant updated', enabled: false };

    const denied = await asRole(roles[1]).resource('tenants').update({
      filterByTk: 'managed-tenant',
      values,
    });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await readTenants()).toEqual(before);

    const updated = await asRole(roles[0]).resource('tenants').update({
      filterByTk: 'managed-tenant',
      values,
    });
    expect(updated.status).toBe(200);
    const after = await readTenants();
    expect(after.filter(({ id }) => id !== 'managed-tenant')).toEqual(
      before.filter(({ id }) => id !== 'managed-tenant'),
    );
    expect(after.find(({ id }) => id === 'managed-tenant')).toMatchObject({
      id: 'managed-tenant',
      name: values.name,
      enabled: 0,
      path: '/managed-tenant/',
    });
  });
});
