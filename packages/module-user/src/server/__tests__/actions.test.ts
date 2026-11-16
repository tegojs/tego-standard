import { createMockServer, MockServer } from '@tachybase/test';
import Database from '@tego/server';

describe('actions', () => {
  let app: MockServer;
  let db: Database;
  let adminUser;
  let agent;
  let adminAgent;
  let pluginUser;

  beforeEach(async () => {
    process.env.INIT_ROOT_EMAIL = 'test@tachybase.com';
    process.env.INIT_ROOT_PASSWORD = '123456';
    process.env.INIT_ROOT_NICKNAME = 'Test';
    app = await createMockServer({
      plugins: ['auth', 'users'],
    });
    db = app.db;

    pluginUser = app.pm.get('users');
    adminUser = await db.getRepository('users').findOne({
      filter: {
        email: process.env.INIT_ROOT_EMAIL,
      },
    });

    agent = app.agent();
    adminAgent = app.agent().login(adminUser);
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('update profile', async () => {
    const res1 = await agent.resource('users').updateProfile({
      filterByTk: adminUser.id,
      values: {
        nickname: 'a',
      },
    });
    expect(res1.status).toBe(401);

    const res2 = await adminAgent.resource('users').updateProfile({
      filterByTk: adminUser.id,
      values: {
        nickname: 'a',
      },
    });
    expect(res2.status).toBe(200);
  });

  it('does not allow a profile update to assign a privileged special role', async () => {
    const account = 'profile-escalation-user';
    const password = 'profile-escalation-password';
    const user = await db.getRepository('users').create({
      values: {
        username: account,
        email: 'profile-escalation-user@example.com',
        nickname: 'Ordinary user',
        password,
      },
    });

    const login = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });

    const saved = await app
      .agent()
      .set('Authorization', `Bearer ${login.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .resource('users')
      .updateProfile({ values: { specialRole: 'root' } });

    expect(saved.status).toBe(200);
    const persisted = await db.getCollection('users').model.findByPk(user.id, { raw: true });
    expect(persisted.specialRole).toBeNull();
  });

  it('does not allow a profile update to change the managed account status', async () => {
    const account = 'profile-status-user';
    const password = 'profile-status-password';
    const user = await db.getRepository('users').create({
      values: {
        username: account,
        email: 'profile-status-user@example.com',
        nickname: 'Ordinary user',
        password,
      },
    });

    const login = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(login.status).toBe(200);
    const saved = await app
      .agent()
      .set('Authorization', `Bearer ${login.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .resource('users')
      .updateProfile({ values: { nickname: 'Profile edited', status: 'pending' } });

    expect(saved.status).toBe(200);
    const persisted = await db.getCollection('users').model.findByPk(user.id, { raw: true });
    expect(persisted).toMatchObject({ nickname: 'Profile edited', status: 'active' });
  });
});
