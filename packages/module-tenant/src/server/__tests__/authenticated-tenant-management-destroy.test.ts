import { createTenantApp } from './utils';

describe('authenticated tenant management destroy boundary', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('allows managers to delete an empty leaf tenant without granting the write to impersonators', async () => {
    app = await createTenantApp();
    const roles = ['tenant-destroy-manager', 'tenant-destroy-impersonator'];
    await app.db.getRepository('roles').create({
      values: [
        { name: roles[0], strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
        { name: roles[1], strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
      ],
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'managed-tenant', name: 'Managed tenant', enabled: true },
        { id: 'control-tenant', name: 'Control tenant', enabled: true },
      ],
    });
    const password = 'tenant-destroy-manager-password';
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

    const denied = await asRole(roles[1]).resource('tenants').destroy({ filterByTk: 'managed-tenant' });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await readTenants()).toEqual(before);

    const destroyed = await asRole(roles[0]).resource('tenants').destroy({ filterByTk: 'managed-tenant' });
    expect(destroyed.status).toBe(200);
    expect(destroyed.body).toHaveProperty('data');
    expect(await readTenants()).toEqual(before.filter(({ id }) => id !== 'managed-tenant'));
  });
});
