import { createMockServer, MockServer } from '@tachybase/test';

describe('authenticated list users excluding a role', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { access: 'without user management', snippets: [], status: 403 },
    { access: 'with user management', snippets: ['pm.users.*'], status: 200 },
  ])('enforces the custom user-list permission $access', async ({ snippets, status }) => {
    app = await createMockServer({
      acl: true,
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'ordinary-role-list-exclude';
    const password = 'ordinary-role-list-exclude-password';
    const roles = app.db.getRepository('roles');
    const users = app.db.getRepository('users');
    await roles.create({
      values: { name: role, strategy: { actions: [] }, snippets },
    });
    const user = await users.create({
      values: {
        username: 'ordinary-role-list-exclude',
        email: 'ordinary-role-list-exclude@example.com',
        password,
        roles: [role],
      },
    });
    const target = await users.create({
      values: { username: 'list-exclude-target', email: 'list-exclude-target@example.com', roles: [role] },
    });
    const membershipsBefore = await app.db
      .getRepository('rolesUsers')
      .find({ raw: true, sort: ['userId', 'roleName'] });
    expect(membershipsBefore).toContainEqual(expect.objectContaining({ userId: user.id, roleName: role }));
    expect((await roles.findOne({ filterByTk: role })).get('snippets')).toEqual(snippets);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: user.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role);
    const identities: Array<{ userId: number; role: string }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'users' && ctx.action.actionName === 'listExcludeRole') {
          identities.push({ userId: ctx.state.currentUser.id, role: ctx.state.currentRole });
        }
        await next();
      },
      { after: 'setCurrentRole', before: 'acl' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });

    const response = await agent.resource('users').listExcludeRole({ roleName: ['admin'] });

    expect(response.status).toBe(status);
    expect(identities).toEqual([{ userId: user.id, role }]);
    if (status === 403) {
      expect(response.body).not.toHaveProperty('data');
    } else {
      expect(response.body.data.map((row: { id: number }) => row.id).sort()).toEqual([user.id, target.id].sort());
      expect(response.body.meta.count).toBe(2);
    }
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      membershipsBefore,
    );
  });
});
