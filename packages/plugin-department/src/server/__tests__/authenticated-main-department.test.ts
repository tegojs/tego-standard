import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated main department management', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { access: 'without department management', snippets: [], allowed: false },
    { access: 'with department management', snippets: ['pm.department'], allowed: true },
  ])("protects another user's main department $access", async ({ snippets, allowed }) => {
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
    const role = 'main-department-operator';
    const password = 'main-department-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'main-department-operator', password, roles: [role] },
    });
    const target = await users.create({
      values: { username: 'main-department-target', roles: ['member'] },
    });
    await app.db.getRepository('departments').createMany({
      records: [
        { id: 101, title: 'Original main department' },
        { id: 102, title: 'Other department' },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: operator.id, departmentId: 101, isMain: true, isOwner: false },
        { userId: target.id, departmentId: 101, isMain: true, isOwner: true },
        { userId: target.id, departmentId: 102, isMain: false, isOwner: false },
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
      { userId: operator.id, departmentId: 101, isMain: true, isOwner: false },
      { userId: target.id, departmentId: 101, isMain: true, isOwner: true },
      { userId: target.id, departmentId: 102, isMain: false, isOwner: false },
    ]);
    const roleMembershipsBefore = await app.db
      .getRepository('rolesUsers')
      .find({ raw: true, sort: ['userId', 'roleName'] });
    expect(roleMembershipsBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));
    expect((await app.db.getRepository('roles').findOne({ filterByTk: role })).get('snippets')).toEqual(snippets);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const identities: Array<{ userId: number; role: string }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'users' && ctx.action.actionName === 'setMainDepartment') {
          identities.push({ userId: ctx.state.currentUser.id, role: ctx.state.currentRole });
        }
        await next();
      },
      { after: 'setCurrentRole', before: 'acl' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const departmentsBefore = await app.db.getRepository('departments').find({ raw: true, sort: ['id'] });

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('users')
      .setMainDepartment({ values: { userId: target.id, departmentId: 102 } });

    expect(identities).toEqual([{ userId: operator.id, role }]);
    const after = await readMemberships();
    if (allowed) {
      expect(response.status).toBe(200);
      expect(after).toEqual(
        before.map((row) =>
          row.userId === target.id ? { ...row, isMain: row.departmentId === 102, updatedAt: expect.any(String) } : row,
        ),
      );
    } else {
      expect(after, `HTTP ${response.status}`).toEqual(before);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    }
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('departments').find({ raw: true, sort: ['id'] })).toEqual(departmentsBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      roleMembershipsBefore,
    );
  });
});
