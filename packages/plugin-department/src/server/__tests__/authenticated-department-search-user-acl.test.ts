import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department search user ACL', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { access: 'without users:list', snippets: [], allowed: false },
    { access: 'with the department management snippet', snippets: ['pm.department'], allowed: true },
  ])('$access', async ({ snippets, allowed }) => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'acl',
        'auth',
        'users',
        'data-source-manager',
        'error-handler',
        [
          PluginDepartmentServer,
          { name: 'department', packageName: '@tachybase/plugin-department', workspaceSource: true },
        ],
      ],
    });
    const role = 'department-user-search-operator';
    const password = 'department-user-search-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets } });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments',
        usingActionsConfig: true,
        actions: [{ name: 'aggregateSearch', fields: ['id', 'title'] }],
      },
    });
    const actionConfig = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).findOne({});
    expect(actionConfig.get('name')).toBe('aggregateSearch');
    expect(
      await app.db.getRepository('dataSourcesRolesResources').count({
        filter: { roleName: role, name: 'users' },
      }),
    ).toBe(0);

    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'department-search-operator', password, roles: [role] },
    });
    const privateUser = await users.create({
      values: {
        username: 'private-search-result',
        nickname: 'Private Search Result',
        phone: '555-0101',
        email: 'private-search-result@example.test',
        roles: ['member'],
      },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const observed: Array<{ userId: number; role: string }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'departments' && ctx.action.actionName === 'aggregateSearch') {
          observed.push({ userId: ctx.state.currentUser.id, role: ctx.state.currentRole });
        }
        await next();
      },
      { after: 'setCurrentRole', before: 'acl' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const rolesBefore = await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] });
    expect(rolesBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('departments')
      .aggregateSearch({ values: { keyword: 'private-search-result', type: 'user', limit: 10 } });

    expect(response.status).toBe(200);
    expect(observed).toEqual([{ userId: operator.id, role }]);
    if (allowed) {
      expect(response.body.data.users).toEqual([
        expect.objectContaining({
          id: privateUser.id,
          username: 'private-search-result',
          phone: '555-0101',
          email: 'private-search-result@example.test',
        }),
      ]);
    } else {
      expect(response.body.data.users).toEqual([]);
    }
    expect(response.body.data.departments).toEqual([]);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      rolesBefore,
    );
    expect(usersBefore).toContainEqual(expect.objectContaining({ id: privateUser.id, phone: '555-0101' }));
  });
});
