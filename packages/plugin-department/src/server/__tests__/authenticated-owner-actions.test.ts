import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department owner actions', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { action: 'setOwner', allowed: false, initialOwner: false },
    { action: 'setOwner', allowed: true, initialOwner: false },
    { action: 'removeOwner', allowed: false, initialOwner: true },
    { action: 'removeOwner', allowed: true, initialOwner: true },
  ])('$action with department management permission: $allowed', async ({ action, allowed, initialOwner }) => {
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
    const role = 'department-owner-action-operator';
    const password = 'department-owner-action-password';
    const snippets = allowed ? ['pm.department'] : [];
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets } });
    expect((await app.db.getRepository('roles').findOne({ filterByTk: role })).get('snippets')).toEqual(snippets);
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: 'owner-action-operator', password, roles: [role] } });
    const target = await users.create({ values: { username: 'owner-action-target', roles: ['member'] } });
    const departments = app.db.getRepository('departments');
    await departments.createMany({
      records: [
        { id: 101, title: 'Target department', isLeaf: true },
        { id: 102, title: 'Unrelated department', isLeaf: true },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: operator.id, departmentId: 101, isMain: true, isOwner: initialOwner },
        { userId: target.id, departmentId: 101, isMain: true, isOwner: initialOwner },
        { userId: target.id, departmentId: 102, isMain: false, isOwner: initialOwner },
      ],
    });
    const readMemberships = async () =>
      (await memberships.find({ raw: true, sort: ['userId', 'departmentId'] })).map((row) => ({
        ...row,
        isMain: Boolean(row.isMain),
        isOwner: Boolean(row.isOwner),
      }));
    const before = await readMemberships();
    expect(
      before.map(({ userId, departmentId, isMain, isOwner }) => ({ userId, departmentId, isMain, isOwner })),
    ).toEqual([
      { userId: operator.id, departmentId: 101, isMain: true, isOwner: initialOwner },
      { userId: target.id, departmentId: 101, isMain: true, isOwner: initialOwner },
      { userId: target.id, departmentId: 102, isMain: false, isOwner: initialOwner },
    ]);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const identities: Array<{ userId: number; role: string }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'departments' && ctx.action.actionName === action) {
          identities.push({ userId: ctx.state.currentUser.id, role: ctx.state.currentRole });
        }
        await next();
      },
      { after: 'setCurrentRole', before: 'acl' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const departmentsBefore = await departments.find({ raw: true, sort: ['id'] });
    const rolesBefore = await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] });
    expect(rolesBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));

    const resource = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('departments');
    const response = await resource[action]({ values: { userId: target.id, departmentId: 101 } });

    expect(identities).toEqual([{ userId: operator.id, role }]);
    if (allowed) {
      expect(response.status).toBe(200);
      expect(await readMemberships()).toEqual(
        before.map((row) =>
          row.userId === target.id && row.departmentId === 101
            ? { ...row, isOwner: !initialOwner, updatedAt: expect.any(String) }
            : row,
        ),
      );
    } else {
      expect(await readMemberships(), `HTTP ${response.status}`).toEqual(before);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    }
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await departments.find({ raw: true, sort: ['id'] })).toEqual(departmentsBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      rolesBefore,
    );
  });
});
