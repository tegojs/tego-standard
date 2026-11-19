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

  it('allows managers to load the persisted tenant tree without granting enumeration to impersonators', async () => {
    app = await createTenantApp();
    const roles = ['tenant-tree-list-manager', 'tenant-tree-list-impersonator'];
    await app.db.getRepository('roles').create({
      values: [
        { name: roles[0], strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
        { name: roles[1], strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
      ],
    });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'tree-list-root', name: 'Tree list root', enabled: true },
        { id: 'tree-list-child', name: 'Tree list child', parentId: 'tree-list-root', enabled: true },
        { id: 'tree-list-other', name: 'Tree list other', enabled: true },
      ],
    });
    const password = 'tenant-tree-list-password';
    const manager = await app.db.getRepository('users').create({
      values: { username: roles[0], password, roles },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: manager.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const asRole = (role: string) =>
      app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role);

    const impersonatorList = await asRole(roles[1]).resource('tenants').list({ page: 1, pageSize: 20 });
    expect(impersonatorList.status).toBe(403);
    expect(impersonatorList.body).not.toHaveProperty('data');

    const managerList = await asRole(roles[0]).resource('tenants').list({ page: 1, pageSize: 20 });
    expect(managerList.status).toBe(200);
    expect(managerList.body.data.map(({ id, parentId, path }) => ({ id, parentId, path }))).toEqual([
      { id: 'tree-list-root', parentId: null, path: '/tree-list-root/' },
      { id: 'tree-list-child', parentId: 'tree-list-root', path: '/tree-list-root/tree-list-child/' },
      { id: 'tree-list-other', parentId: null, path: '/tree-list-other/' },
    ]);
    const impersonatorGet = await asRole(roles[1])
      .resource('tenants')
      .get({
        filterByTk: 'tree-list-child',
        fields: ['id', 'parentId', 'path'],
      });
    expect(impersonatorGet.status).toBe(403);
    expect(impersonatorGet.body).not.toHaveProperty('data');
    const managerGet = await asRole(roles[0])
      .resource('tenants')
      .get({
        filterByTk: 'tree-list-child',
        fields: ['id', 'parentId', 'path'],
      });
    expect(managerGet.status).toBe(200);
    expect(managerGet.body.data).toEqual({
      id: 'tree-list-child',
      parentId: 'tree-list-root',
      path: '/tree-list-root/tree-list-child/',
    });
    expect(await app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] })).toHaveLength(3);
  });
});
