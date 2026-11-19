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

  it('does not let a manager delete a tenant that still has members', async () => {
    app = await createTenantApp();
    const role = 'tenant-destroy-member-manager';
    const password = 'tenant-destroy-member-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tenant-with-member', name: 'Tenant with member', enabled: true },
        { id: 'control-tenant', name: 'Control tenant', enabled: true },
      ],
    });
    const member = await app.db.getRepository('users').create({
      values: {
        username: 'tenant-destroy-member',
        password,
        roles: [role],
        tenants: ['tenant-with-member'],
        defaultTenantId: 'control-tenant',
      },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: member.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const beforeTenants = await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
    const beforeMemberships = await app.db
      .getCollection('tenantUsers')
      .model.findAll({ raw: true, order: [['tenantId', 'ASC']] });

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('tenants')
      .destroy({ filterByTk: 'tenant-with-member' });

    expect(response.status).toBe(500);
    expect(response.body.errors?.[0]?.message).toBe(
      'This tenant still has members. Remove all members before deleting it.',
    );
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      beforeTenants,
    );
    expect(
      await app.db.getCollection('tenantUsers').model.findAll({ raw: true, order: [['tenantId', 'ASC']] }),
    ).toEqual(beforeMemberships);
  });

  it('does not let a manager delete a tenant used as a user default tenant', async () => {
    app = await createTenantApp();
    const role = 'tenant-destroy-default-manager';
    const password = 'tenant-destroy-default-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'default-tenant', name: 'Default tenant', enabled: true },
        { id: 'control-tenant', name: 'Control tenant', enabled: true },
      ],
    });
    const manager = await app.db.getRepository('users').create({
      values: {
        username: role,
        password,
        roles: [role],
        tenants: ['default-tenant', 'control-tenant'],
        defaultTenantId: 'default-tenant',
      },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: manager.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const beforeTenants = await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
    const beforeUser = await app.db.getRepository('users').findOne({ filterByTk: manager.id });

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('tenants')
      .destroy({ filterByTk: 'default-tenant' });

    expect(response.status).toBe(500);
    expect(response.body.errors?.[0]?.message).toBe(
      "This tenant is set as a user's default tenant. Reassign those users before deleting it.",
    );
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toEqual(
      beforeTenants,
    );
    expect(await app.db.getRepository('users').findOne({ filterByTk: manager.id })).toMatchObject({
      id: beforeUser.get('id'),
      defaultTenantId: 'default-tenant',
    });
  });
});
