import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated list users excluding a department', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { access: 'without department management', snippets: [], status: 403 },
    { access: 'with department management', snippets: ['pm.department'], status: 200 },
  ])('enforces department management permission $access', async ({ snippets, status }) => {
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
    const role = 'ordinary-role-list-exclude-dept';
    const password = 'ordinary-role-list-exclude-dept-password';
    const roles = app.db.getRepository('roles');
    const users = app.db.getRepository('users');
    await roles.create({ values: { name: role, strategy: { actions: [] }, snippets } });
    const operator = await users.create({
      values: { username: 'ordinary-role-list-exclude-dept', password, roles: [role] },
    });
    const departmentMember = await users.create({
      values: {
        username: 'candidate-department-member',
        nickname: 'Candidate Department Member',
        phone: '555-0201',
        email: 'candidate-department-member@example.test',
        roles: ['member'],
      },
    });
    const eligibleUser = await users.create({
      values: {
        username: 'candidate-eligible-user',
        nickname: 'Candidate Eligible User',
        phone: '555-0202',
        email: 'candidate-eligible-user@example.test',
        roles: ['member'],
      },
    });
    const department = await app.db.getRepository('departments').create({
      values: { title: 'Managed department', isLeaf: true },
    });
    await app.db.getRepository('departmentsUsers').create({
      values: { userId: departmentMember.id, departmentId: department.id, isMain: true, isOwner: false },
    });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const identities: Array<{ userId: number; role: string }> = [];
    app.resourcer.use(
      async (ctx, next) => {
        if (ctx.action.resourceName === 'users' && ctx.action.actionName === 'listExcludeDept') {
          identities.push({ userId: ctx.state.currentUser.id, role: ctx.state.currentRole });
        }
        await next();
      },
      { after: 'setCurrentRole', before: 'acl' },
    );
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const roleMembershipsBefore = await app.db
      .getRepository('rolesUsers')
      .find({ raw: true, sort: ['userId', 'roleName'] });
    const departmentMembershipsBefore = await app.db
      .getRepository('departmentsUsers')
      .find({ raw: true, sort: ['userId', 'departmentId'] });
    expect(roleMembershipsBefore).toContainEqual(expect.objectContaining({ userId: operator.id, roleName: role }));
    expect(await roles.findOne({ filterByTk: role }).then((record) => record.get('snippets'))).toEqual(snippets);

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('users')
      .listExcludeDept({
        departmentId: department.id,
        page: 1,
        pageSize: 10,
        filter: { username: { $includes: 'candidate-' } },
      });

    expect(response.status).toBe(status);
    expect(identities).toEqual([{ userId: operator.id, role }]);
    if (status === 403) {
      expect(response.body).not.toHaveProperty('data');
    } else {
      expect(response.body.data).toEqual([
        expect.objectContaining({
          id: eligibleUser.id,
          username: 'candidate-eligible-user',
          phone: '555-0202',
          email: 'candidate-eligible-user@example.test',
        }),
      ]);
      expect(response.body.meta.count).toBe(1);
    }
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('rolesUsers').find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(
      roleMembershipsBefore,
    );
    expect(
      await app.db.getRepository('departmentsUsers').find({ raw: true, sort: ['userId', 'departmentId'] }),
    ).toEqual(departmentMembershipsBefore);
  });
});
