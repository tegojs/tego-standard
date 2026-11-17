import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department owner data scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    {
      target: 102,
      requestFilter: undefined,
      canUpdate: false,
      boundary: 'outside persisted scope',
      targetUserAccess: 'none',
    },
    {
      target: 101,
      requestFilter: undefined,
      canUpdate: true,
      boundary: 'inside persisted scope',
      targetUserAccess: 'all',
    },
    {
      target: 101,
      requestFilter: { title: 'Allowed department' },
      canUpdate: true,
      boundary: 'matching request filter',
      targetUserAccess: 'all',
    },
    {
      target: 101,
      requestFilter: { title: 'Nonmatching title' },
      canUpdate: false,
      boundary: 'excluded by request filter',
      targetUserAccess: 'none',
    },
    {
      target: 101,
      requestFilter: undefined,
      canUpdate: false,
      boundary: 'target user outside users:list scope',
      targetUserAccess: 'original-owner',
    },
    {
      target: 101,
      requestFilter: undefined,
      canUpdate: true,
      boundary: 'missing users:list permission',
      targetUserAccess: 'none',
    },
  ])('honors $boundary', async ({ target, requestFilter, canUpdate, targetUserAccess }) => {
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
    const role = 'department-scope-operator';
    const password = 'department-scope-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const scopeFilter = { id: { $eq: 101 } };
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: { dataSourceKey: 'main', name: 'Only department 101', resourceName: 'departments', scope: scopeFilter },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments',
        usingActionsConfig: true,
        actions: [{ name: 'update', fields: ['title', 'owners'], scope: { id: scope.id } }],
      },
    });
    const storedActions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).find({});
    expect(storedActions).toHaveLength(1);
    expect(storedActions[0].get('scopeId')).toBe(scope.id);
    expect(
      (await app.db.getRepository('dataSourcesRolesResourcesScopes').findOne({ filterByTk: scope.id })).get('scope'),
    ).toEqual(scopeFilter);

    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: 'department-scope-operator', password, roles: [role] } });
    const originalOwner = await users.create({ values: { username: 'scope-original-owner', roles: ['member'] } });
    const nextOwner = await users.create({ values: { username: 'scope-next-owner', roles: ['member'] } });
    let userScope;
    if (targetUserAccess === 'original-owner') {
      userScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          dataSourceKey: 'main',
          name: 'Only the original owner',
          resourceName: 'users',
          scope: { id: { $eq: originalOwner.id } },
        },
      });
    }
    if (targetUserAccess !== 'none') {
      const userResource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users',
          usingActionsConfig: true,
          actions: [
            {
              name: 'list',
              fields: ['id'],
              ...(userScope ? { scope: { id: userScope.id } } : {}),
            },
          ],
        },
      });
      const userAction = await app.db.getRepository('dataSourcesRolesResources.actions', userResource.id).findOne({});
      expect(userAction.get('scopeId')).toBe(userScope?.id ?? null);
    }
    const departments = app.db.getRepository('departments');
    await departments.createMany({
      records: [
        { id: 101, title: 'Allowed department', isLeaf: true },
        { id: 102, title: 'Excluded department', isLeaf: true },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: originalOwner.id, departmentId: 101, isMain: true, isOwner: true },
        { userId: nextOwner.id, departmentId: 101, isMain: false, isOwner: false },
        { userId: originalOwner.id, departmentId: 102, isMain: false, isOwner: true },
        { userId: nextOwner.id, departmentId: 102, isMain: true, isOwner: false },
      ],
    });
    const readMemberships = async () =>
      (await memberships.find({ raw: true, sort: ['departmentId', 'userId'] })).map((row) => ({
        ...row,
        isMain: Boolean(row.isMain),
        isOwner: Boolean(row.isOwner),
      }));
    const before = await readMemberships();
    expect(before).toHaveLength(4);
    expect(before.filter((row) => row.isOwner).map((row) => row.userId)).toEqual([originalOwner.id, originalOwner.id]);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const observed: Array<{ userId: number; role: string; filter: unknown; whitelist: unknown }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'departments' && ctx.action.actionName === 'update') {
          observed.push({
            userId: ctx.state.currentUser.id,
            role: ctx.state.currentRole,
            filter: ctx.action.params.filter,
            whitelist: ctx.action.params.whitelist,
          });
        }
        await next();
      },
      { after: 'acl', before: 'setDepartmentOwners' },
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
      .update({
        filterByTk: target,
        filter: requestFilter,
        values: { title: 'Updated department', owners: [{ id: nextOwner.id }] },
      });

    const expectTargetDenied = targetUserAccess === 'original-owner' || (targetUserAccess === 'none' && canUpdate);
    if (expectTargetDenied) {
      expect(await readMemberships()).toEqual(before);
      expect(await departments.find({ raw: true, sort: ['id'] })).toEqual(departmentsBefore);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    } else {
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(canUpdate ? 1 : 0);
    }
    expect(observed).toEqual([
      { userId: operator.id, role, filter: expect.any(Object), whitelist: ['owners', 'title'] },
    ]);
    if (!expectTargetDenied) {
      expect(await departments.find({ raw: true, sort: ['id'] })).toEqual(
        departmentsBefore.map((row) =>
          canUpdate && row.id === target
            ? { ...row, title: 'Updated department', updatedById: operator.id, updatedAt: expect.any(String) }
            : row,
        ),
      );
      expect(await readMemberships()).toEqual(
        before.map((row) =>
          canUpdate && row.departmentId === target
            ? { ...row, isOwner: row.userId === nextOwner.id, updatedAt: expect.any(String) }
            : row,
        ),
      );
    }
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      rolesBefore,
    );
  });
});
