import { createTenantApp } from './utils';

describe('authenticated collection tenant isolation configuration', () => {
  let app: Awaited<ReturnType<typeof createTenantApp>>;

  afterEach(async () => {
    await app?.destroy();
  });

  it('lets managers persist collection isolation settings but denies impersonators', async () => {
    app = await createTenantApp();
    const roles = ['collection-config-manager', 'collection-config-impersonator'];
    const password = 'collection-config-password';
    await app.db.getRepository('roles').create({
      values: [
        { name: roles[0], strategy: { actions: [] }, snippets: ['pm.tenant.manage'] },
        { name: roles[1], strategy: { actions: [] }, snippets: ['pm.tenant.impersonate'] },
      ],
    });
    const agents = [];
    for (const role of roles) {
      const user = await app.db.getRepository('users').create({ values: { username: role, password, roles: [role] } });
      const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: user.username,
        password,
      });
      expect(signIn.status).toBe(200);
      agents.push(
        app
          .agent()
          .set('Authorization', `Bearer ${signIn.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role),
      );
    }

    const name = 'authenticated_collection_isolation_documents';
    await app.db.getRepository('collections').create({
      values: { name, fields: [{ type: 'string', name: 'title' }] },
      context: {},
    });
    const collection = app.db.getCollection(name);
    const policy = { tenancy: 'tenantScoped', legacyDataTenantIds: ['legacy-tenant'], allowEditingLegacyData: true };
    const original = await app.db.getCollection('collections').model.findOne({ where: { name }, raw: true });

    const denied = await agents[1].resource('collections').update({ filterByTk: name, values: policy });
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('collections').model.findOne({ where: { name }, raw: true })).toEqual(original);
    expect(collection.options).not.toMatchObject(policy);

    const updated = await agents[0].resource('collections').update({ filterByTk: name, values: policy });
    expect(updated.status).toBe(200);
    const persisted = await app.db.getCollection('collections').model.findOne({ where: { name }, raw: true });
    expect(persisted.name).toBe(name);
    expect(JSON.parse(persisted.options)).toMatchObject(policy);
    expect(collection.options).toMatchObject(policy);
  });
});
