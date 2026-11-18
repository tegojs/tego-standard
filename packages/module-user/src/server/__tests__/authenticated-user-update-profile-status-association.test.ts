import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user profile status association', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { field: 'statusInfo', value: { key: 'disabled' } },
    { field: 'previousStatus', value: 'disabled' },
    { field: 'previousStatusInfo', value: { key: 'disabled' } },
    { field: 'statusExpireAt', value: '2030-01-01T00:00:00.000Z' },
    { field: 'statusReason', value: 'Profile supplied reason' },
  ])('does not allow profile updates to change managed status through $field', async ({ field, value }) => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const password = 'profile-status-association-password';
    const statuses = app.db.getRepository('userStatuses');
    await statuses.create({ values: { key: 'active', title: 'Active', allowLogin: true, isSystemDefined: true } });
    await statuses.create({ values: { key: 'disabled', title: 'Disabled', allowLogin: false, isSystemDefined: true } });
    const users = app.db.getRepository('users');
    const user = await users.create({
      values: {
        username: 'profile-status-association-user',
        email: 'profile-status-association@example.com',
        nickname: 'Ordinary user',
        password,
        status: 'active',
        previousStatus: 'active',
      },
    });
    const histories = app.db.getRepository('userStatusHistories');
    const historiesBefore = await histories.find({ raw: true, sort: ['id'] });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: user.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .resource('users')
      .updateProfile({ values: { nickname: 'Profile edited', [field]: value } });

    expect(response.status).toBe(200);
    expect(await users.findOne({ filterByTk: user.id, raw: true })).toMatchObject({
      nickname: 'Profile edited',
      status: 'active',
      previousStatus: 'active',
      statusExpireAt: null,
      statusReason: null,
    });
    expect(await histories.find({ raw: true, sort: ['id'] })).toEqual(historiesBefore);
  });
});
