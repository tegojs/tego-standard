import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department owner field permission', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { field: 'title', canChangeOwners: false },
    { field: 'owners', canChangeOwners: true },
    { field: 'management snippet', canChangeOwners: true },
  ])('honors persisted $field update permission', async ({ field, canChangeOwners }) => {
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
    const role = 'department-field-operator';
    const password = 'department-field-password';
    await app.db.getRepository('roles').create({
      values: {
        name: role,
        strategy: { actions: [] },
        snippets: field === 'management snippet' ? ['pm.department'] : [],
      },
    });
    if (field !== 'management snippet') {
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'update', fields: [field] }],
        },
      });
      const storedActions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).find({});
      expect(storedActions).toHaveLength(1);
      expect(storedActions[0].get('fields')).toEqual([field]);
    }

    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'department-field-operator', password, roles: [role] },
    });
    const originalOwner = await users.create({ values: { username: 'department-original-owner', roles: ['member'] } });
    const nextOwner = await users.create({ values: { username: 'department-next-owner', roles: ['member'] } });
    const departments = app.db.getRepository('departments');
    await departments.createMany({
      records: [
        { id: 101, title: 'Original department', isLeaf: true },
        { id: 102, title: 'Unrelated department', isLeaf: true },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: originalOwner.id, departmentId: 101, isMain: true, isOwner: true },
        { userId: nextOwner.id, departmentId: 101, isMain: false, isOwner: false },
        { userId: originalOwner.id, departmentId: 102, isMain: false, isOwner: true },
      ],
    });
    const readMemberships = async () =>
      (await memberships.find({ raw: true, sort: ['departmentId', 'userId'] })).map((row) => ({
        ...row,
        isMain: Boolean(row.isMain),
        isOwner: Boolean(row.isOwner),
      }));
    const before = await readMemberships();
    expect(before.map(({ userId, departmentId, isOwner }) => ({ userId, departmentId, isOwner }))).toEqual([
      { userId: originalOwner.id, departmentId: 101, isOwner: true },
      { userId: nextOwner.id, departmentId: 101, isOwner: false },
      { userId: originalOwner.id, departmentId: 102, isOwner: true },
    ]);
    const roleMembershipsBefore = await app.db
      .getRepository('rolesUsers')
      .find({ raw: true, sort: ['userId', 'roleName'] });
    expect(roleMembershipsBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const observed: Array<{ userId: number; role: string; whitelist: unknown }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'departments' && ctx.action.actionName === 'update') {
          observed.push({
            userId: ctx.state.currentUser.id,
            role: ctx.state.currentRole,
            whitelist: ctx.action.params.whitelist,
          });
        }
        await next();
      },
      { after: 'acl', before: 'setDepartmentOwners' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const unrelatedBefore = await departments.findOne({ filterByTk: 102, raw: true });

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('departments')
      .update({
        filterByTk: 101,
        values: { title: 'Updated department', owners: [{ id: nextOwner.id }] },
      });

    expect(response.status).toBe(200);
    expect(observed).toEqual([
      { userId: operator.id, role, whitelist: field === 'management snippet' ? undefined : [field] },
    ]);
    expect((await departments.findOne({ filterByTk: 101 })).get('title')).toBe(
      field === 'owners' ? 'Original department' : 'Updated department',
    );
    const after = await readMemberships();
    if (canChangeOwners) {
      expect(after).toEqual(
        before.map((row) =>
          row.departmentId === 101
            ? { ...row, isOwner: row.userId === nextOwner.id, updatedAt: expect.any(String) }
            : row,
        ),
      );
    } else {
      expect(after).toEqual(before);
    }
    expect(await departments.findOne({ filterByTk: 102, raw: true })).toEqual(unrelatedBefore);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      roleMembershipsBefore,
    );
  });
});
