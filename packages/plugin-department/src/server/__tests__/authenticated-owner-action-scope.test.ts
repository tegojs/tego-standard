import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department owner action data scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { action: 'setOwner', target: 101, initialOwner: false, canUpdate: true },
    { action: 'setOwner', target: 102, initialOwner: false, canUpdate: false },
    { action: 'removeOwner', target: 101, initialOwner: true, canUpdate: true },
    { action: 'removeOwner', target: 102, initialOwner: true, canUpdate: false },
  ])(
    '$action on department $target respects the persisted scope',
    async ({ action, target, initialOwner, canUpdate }) => {
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
      const role = 'department-owner-scope-operator';
      const password = 'department-owner-scope-password';
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
          actions: [{ name: action, fields: [], scope: { id: scope.id } }],
        },
      });
      const actionConfig = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).findOne({});
      expect(actionConfig.get('name')).toBe(action);
      expect(actionConfig.get('scopeId')).toBe(scope.id);
      expect(
        (await app.db.getRepository('dataSourcesRolesResourcesScopes').findOne({ filterByTk: scope.id })).get('scope'),
      ).toEqual(scopeFilter);

      const users = app.db.getRepository('users');
      const operator = await users.create({
        values: { username: 'owner-scope-operator', password, roles: [role] },
      });
      const targetUser = await users.create({ values: { username: 'owner-scope-target', roles: ['member'] } });
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
          { userId: operator.id, departmentId: 101, isMain: true, isOwner: initialOwner },
          { userId: targetUser.id, departmentId: 101, isMain: true, isOwner: initialOwner },
          { userId: targetUser.id, departmentId: 102, isMain: false, isOwner: initialOwner },
        ],
      });
      const readMemberships = async () =>
        (await memberships.find({ raw: true, sort: ['userId', 'departmentId'] })).map((row) => ({
          ...row,
          isMain: Boolean(row.isMain),
          isOwner: Boolean(row.isOwner),
        }));
      const before = await readMemberships();
      expect(before).toHaveLength(3);
      const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
        account: operator.username,
        password,
      });
      expect(signIn.status).toBe(200);
      expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
      const observed: Array<{ userId: number; role: string; filter: unknown }> = [];
      app.resourcer.use(
        async (ctx, next) => {
          if (ctx.action.resourceName === 'departments' && ctx.action.actionName === action) {
            observed.push({
              userId: ctx.state.currentUser.id,
              role: ctx.state.currentRole,
              filter: ctx.action.params.filter,
            });
          }
          await next();
        },
        { after: 'acl', before: action },
      );
      const roleMembershipsBefore = await app.db
        .getRepository('rolesUsers')
        .find({ raw: true, sort: ['userId', 'roleName'] });
      expect(roleMembershipsBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));
      const usersBefore = await users.find({ raw: true, sort: ['id'] });
      const departmentsBefore = await departments.find({ raw: true, sort: ['id'] });

      const response = await app
        .agent()
        .set('Authorization', `Bearer ${signIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .resource('departments')
        [action]({ values: { userId: targetUser.id, departmentId: target } });

      expect(response.status).toBe(200);
      expect(observed).toEqual([{ userId: operator.id, role, filter: scopeFilter }]);
      expect(await readMemberships()).toEqual(
        before.map((row) =>
          canUpdate && row.userId === targetUser.id && row.departmentId === target
            ? { ...row, isOwner: !initialOwner, updatedAt: expect.any(String) }
            : row,
        ),
      );
      expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
      expect(await departments.find({ raw: true, sort: ['id'] })).toEqual(departmentsBefore);
      expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
        roleMembershipsBefore,
      );
    },
  );
});
