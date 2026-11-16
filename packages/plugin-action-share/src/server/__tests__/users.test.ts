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
});
