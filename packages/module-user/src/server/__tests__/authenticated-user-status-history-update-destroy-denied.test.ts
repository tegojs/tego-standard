import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user status history update and destroy access', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not mutate history records through resource update or destroy actions', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'status-history-write-operator';
    const password = 'status-history-write-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const target = await users.create({ values: { username: 'status-history-write-target', roles: [role] } });
    const histories = app.db.getRepository('userStatusHistories');
    const updateTarget = await histories.create({
      values: {
        userId: target.id,
        fromStatus: 'active',
        toStatus: 'disabled',
        reason: 'Keep this reason',
        operationType: 'manual',
      },
    });
    const destroyTarget = await histories.create({
      values: {
        userId: target.id,
        fromStatus: 'active',
        toStatus: 'disabled',
        reason: 'Keep this row',
        operationType: 'manual',
      },
    });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role);
    const readable = await agent.resource('userStatusHistories').list({ fields: ['id'], pagination: false });
    expect(readable.status).toBe(200);
    expect(readable.body.data.map(({ id }) => id)).toEqual([updateTarget.id, destroyTarget.id]);

    const historiesBefore = await histories.find({ raw: true, sort: ['id'] });
    const update = await agent.resource('userStatusHistories').update({
      filterByTk: updateTarget.id,
      values: { reason: 'Forged edit' },
    });
    const destroy = await agent.resource('userStatusHistories').destroy({ filterByTk: destroyTarget.id });

    expect(update.status).toBe(200);
    expect(destroy.status).toBe(200);
    expect(await histories.find({ raw: true, sort: ['id'] })).toEqual(historiesBefore);
  });
});
