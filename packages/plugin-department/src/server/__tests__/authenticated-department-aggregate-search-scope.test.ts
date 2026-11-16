import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department aggregate search data scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('returns only departments allowed by the persisted action scope', async () => {
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
    const role = 'department-search-scope-operator';
    const password = 'department-search-scope-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const scopeFilter = { id: { $eq: 101 } };
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only department 101',
        resourceName: 'departments',
        scope: scopeFilter,
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments',
        usingActionsConfig: true,
        actions: [{ name: 'aggregateSearch', fields: ['id', 'title'], scope: { id: scope.id } }],
      },
    });
    const actionConfig = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).findOne({});
    expect(actionConfig.get('name')).toBe('aggregateSearch');
    expect(actionConfig.get('scopeId')).toBe(scope.id);
    expect(
      (await app.db.getRepository('dataSourcesRolesResourcesScopes').findOne({ filterByTk: scope.id })).get('scope'),
    ).toEqual(scopeFilter);

    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'department-search-operator', password, roles: [role] },
    });
    const departments = app.db.getRepository('departments');
    await departments.createMany({
      records: [
        { id: 101, title: 'Scope match allowed department', isLeaf: true },
        { id: 102, title: 'Scope match excluded department', isLeaf: true },
      ],
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const observed: Array<{ userId: number; role: string; filter: unknown }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'departments' && ctx.action.actionName === 'aggregateSearch') {
          observed.push({
            userId: ctx.state.currentUser.id,
            role: ctx.state.currentRole,
            filter: ctx.action.params.filter,
          });
        }
        await next();
      },
      { after: 'acl', before: 'aggregateSearch' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const departmentsBefore = await departments.find({ raw: true, sort: ['id'] });
    const rolesBefore = await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] });
    expect(rolesBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('departments')
      .aggregateSearch({ values: { keyword: 'Scope match', type: 'department', limit: 10 } });

    expect(response.status).toBe(200);
    expect(observed).toEqual([{ userId: operator.id, role, filter: scopeFilter }]);
    expect(response.body.data.users).toEqual([]);
    expect(response.body.data.departments.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 101, title: 'Scope match allowed department' },
    ]);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await departments.find({ raw: true, sort: ['id'] })).toEqual(departmentsBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      rolesBefore,
    );
  });
});
