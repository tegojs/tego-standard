import { createMockServer, MockServer } from '@tachybase/test';

import PluginShareServer from '../plugin';

describe('shared user profile actions', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: [
        'acl',
        'error-handler',
        'auth',
        'users',
        'ui-schema-storage',
        'collection-manager',
        'data-source-manager',
        [
          PluginShareServer,
          { name: 'action-share', packageName: '@tachybase/plugin-action-share', workspaceSource: true },
        ],
      ],
    });
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('does not allow a profile update to assign a privileged special role', async () => {
    const account = 'profile-escalation-user';
    const password = 'profile-escalation-password';
    const user = await app.db.getRepository('users').create({
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
    const persisted = await app.db.getCollection('users').model.findByPk(user.id, { raw: true });
    expect(persisted.specialRole).toBeNull();
  });

  it('does not allow a profile update to change the managed account status', async () => {
    const account = 'profile-status-user';
    const password = 'profile-status-password';
    const user = await app.db.getRepository('users').create({
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
    const persisted = await app.db.getCollection('users').model.findByPk(user.id, { raw: true });
    expect(persisted).toMatchObject({ nickname: 'Profile edited', status: 'active' });
  });

  it('does not allow a profile update to replace the password without the password-change flow', async () => {
    const account = 'profile-password-user';
    const password = 'profile-password-old';
    const replacement = 'profile-password-new';
    const user = await app.db.getRepository('users').create({
      values: {
        username: account,
        email: 'profile-password-user@example.com',
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
      .updateProfile({ values: { nickname: 'Profile edited', password: replacement } });

    expect(saved.status).toBe(200);
    expect(saved.body.data[0]).toMatchObject({ id: user.id, nickname: 'Profile edited' });
    const replacementPasswordLogin = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account, password: replacement });
    const oldPasswordLogin = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account, password });
    expect({ oldPassword: oldPasswordLogin.status, replacementPassword: replacementPasswordLogin.status }).toEqual({
      oldPassword: 200,
      replacementPassword: 401,
    });
  });

  it('does not allow a profile update to set a password reset token', async () => {
    const account = 'profile-reset-token-user';
    const password = 'profile-reset-token-old';
    const replacement = 'profile-reset-token-new';
    const resetToken = 'attacker-known-reset-token';
    const user = await app.db.getRepository('users').create({
      values: {
        username: account,
        email: 'profile-reset-token-user@example.com',
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
      .updateProfile({ values: { nickname: 'Profile edited', resetToken } });
    expect(saved.status).toBe(200);
    const persisted = await app.db.getCollection('users').model.findByPk(user.id, { raw: true });

    const reset = await app
      .agent()
      .post('/auth:resetPassword')
      .set('X-Authenticator', 'basic')
      .send({ email: user.email, password: replacement, resetToken });
    const oldPasswordLogin = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account, password });
    const replacementPasswordLogin = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account, password: replacement });

    expect({ persistedResetToken: persisted.resetToken, resetStatus: reset.status }).toEqual({
      persistedResetToken: null,
      resetStatus: 404,
    });
    expect({ oldPassword: oldPasswordLogin.status, replacementPassword: replacementPasswordLogin.status }).toEqual({
      oldPassword: 200,
      replacementPassword: 401,
    });
  });
});
