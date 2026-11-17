import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated role department association scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not assign a department outside the target collection ACL scope to a role', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'acl',
        'auth',
        'users',
        'data-source-manager',
        [
          PluginDepartmentServer,
          { name: 'department', packageName: '@tachybase/plugin-department', workspaceSource: true },
        ],
      ],
    });
    const operatorRole = 'department-role-link-operator';
    const targetRole = 'department-role-link-target';
    const password = 'department-role-link-password';
    await app.db.getRepository('roles').create({
      values: {
        name: operatorRole,
        strategy: { actions: [] },
        snippets: ['pm.acl.roles', 'pm.department'],
      },
    });
    await app.db.getRepository('roles').create({
      values: { name: targetRole, strategy: { actions: [] }, snippets: [] },
    });
    const operator = await app.db.getRepository('users').create({
      values: { username: operatorRole, password, roles: [operatorRole] },
    });
    await app.db.getRepository('departments').createMany({
      records: [
        { id: 101, title: 'Visible department' },
        { id: 102, title: 'Hidden department' },
      ],
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only visible department',
        resourceName: 'departments',
        scope: { id: { $eq: 101 } },
      },
    });
    const targetResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'departments',
        usingActionsConfig: true,
        actions: [
          { name: 'add', fields: ['title'] },
          { name: 'list', fields: ['id'], scope: { id: scope.id } },
        ],
      },
    });
    const targetAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', targetResource.id)
      .findOne({ filter: { name: 'list' } });
    expect(targetAction.get('scopeId')).toBe(scope.id);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', operatorRole);

    const visible = await agent.resource('departments').list({ fields: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data.map(({ id }) => id)).toEqual([101]);

    const assignments = app.db.getRepository('departmentsRoles');
    const allowed = await agent.resource('roles.departments', targetRole).add({ values: [101] });
    expect(allowed.status).toBe(200);
    const before = await assignments.find({ raw: true, filter: { roleName: targetRole } });
    expect(before.map(({ departmentId }) => departmentId)).toEqual([101]);

    const denied = await agent.resource('roles.departments', targetRole).add({ values: [102] });
    expect(await assignments.find({ raw: true, filter: { roleName: targetRole } })).toEqual(before);
    expect(denied.status).toBe(403);
  });

  it('does not remove a department outside the target collection ACL scope from a role', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'acl',
        'auth',
        'users',
        'data-source-manager',
        [
          PluginDepartmentServer,
          { name: 'department', packageName: '@tachybase/plugin-department', workspaceSource: true },
        ],
      ],
    });
    const operatorRole = 'department-role-remove-operator';
    const targetRole = 'department-role-remove-target';
    const password = 'department-role-remove-password';
    await app.db.getRepository('roles').create({
      values: {
        name: operatorRole,
        strategy: { actions: [] },
        snippets: ['pm.acl.roles', 'pm.department'],
      },
    });
    await app.db.getRepository('roles').create({
      values: { name: targetRole, strategy: { actions: [] }, snippets: [] },
    });
    const operator = await app.db.getRepository('users').create({
      values: { username: operatorRole, password, roles: [operatorRole] },
    });
    await app.db.getRepository('departments').createMany({
      records: [
        { id: 101, title: 'Visible department' },
        { id: 102, title: 'Hidden department' },
      ],
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only visible department',
        resourceName: 'departments',
        scope: { id: { $eq: 101 } },
      },
    });
    const targetResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'departments',
        usingActionsConfig: true,
        actions: [
          { name: 'add', fields: ['title'] },
          { name: 'remove', fields: ['id'] },
          { name: 'list', fields: ['id'], scope: { id: scope.id } },
        ],
      },
    });
    const targetAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', targetResource.id)
      .findOne({ filter: { name: 'list' } });
    expect(targetAction.get('scopeId')).toBe(scope.id);
    const assignments = app.db.getRepository('departmentsRoles');
    await assignments.createMany({
      records: [
        { roleName: targetRole, departmentId: 101 },
        { roleName: targetRole, departmentId: 102 },
      ],
    });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });
    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', operatorRole);

    const visible = await agent.resource('departments').list({ fields: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data.map(({ id }) => id)).toEqual([101]);

    const allowed = await agent.resource('roles.departments', targetRole).remove({ values: [101] });
    expect(allowed.status).toBe(200);
    const before = await assignments.find({ raw: true, filter: { roleName: targetRole } });
    expect(before.map(({ departmentId }) => departmentId)).toEqual([102]);

    const denied = await agent.resource('roles.departments', targetRole).remove({ values: [102] });
    expect(denied.status).toBe(403);
    expect(await assignments.find({ raw: true, filter: { roleName: targetRole } })).toEqual(before);
  });
});
