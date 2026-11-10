import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated server-default business writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Dropping defaults breaks valid creates; dropping the create scope wrongly accepts the approved role.
  // 丢失默认值会阻断正常新增；丢失创建范围会错误允许 approved 角色新增 draft 记录。
  it('checks native create scopes against persisted defaults after projecting client fields', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const roles = ['default-draft-writer', 'default-approved-writer'];
    for (const name of roles)
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const account = 'default-task-author';
    const password = 'default-task-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles, tenants: ['B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'defaultBusinessTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'stage', type: 'string', defaultValue: 'draft' },
        ],
      },
    });
    const collection = app.db.getCollection(collectionName);
    expect(collection.model.rawAttributes.stage.defaultValue).toBe('draft');
    const fields = ['id', 'name', 'stage', 'tenantId'];
    for (const [index, stage] of ['draft', 'approved'].entries()) {
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          key: `default-${stage}`,
          dataSourceKey: 'main',
          resourceName: collectionName,
          scope: { stage: { $eq: stage } },
        },
      });
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: roles[index],
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'create', fields: ['name'], scope: { id: scope.get('id') } },
            { name: 'list', fields },
            { name: 'update', fields: ['name'] },
          ],
        },
      });
      const actions = await resource.getActions({ include: ['scope'] });
      expect(
        actions
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
            filter: action.get('scope')?.get('scope') ?? null,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual([
        { name: 'create', fields: ['name'], filter: { stage: { $eq: stage } } },
        { name: 'list', fields: ['id', 'name', 'stage', 'tenantId'], filter: null },
        { name: 'update', fields: ['name'], filter: null },
      ]);
    }
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: roles.map((roleName) => ({
          ...config.rules[0],
          id: roleName,
          subject: {
            type: 'all',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(userId) },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: roleName },
              },
            ],
          },
        })),
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (role = roles[0]) =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(userId);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'First task' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    const first = [{ id: 1, name: 'First task', stage: 'draft', tenantId: 'B' }];
    expect(await rows()).toEqual(first);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(first);
    // Both roles have G; the native create scope alone must reject the incompatible server default.
    // 两个角色都具备 G，必须由原生创建范围独立拒绝不匹配的服务端默认值。
    const denied = await agent(roles[1])
      .resource(collectionName)
      .create({ values: { name: 'Denied task' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual(first);
    const next = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Second task' } });
    expect(next.status).toBe(200);
    expect(next.body.data).toEqual({ keys: [2], affected: 1 });
    const beforeEdit = [...first, { id: 2, name: 'Second task', stage: 'draft', tenantId: 'B' }];
    expect(await rows()).toEqual(beforeEdit);
    const edited = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Edited task' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
    const final = [
      { id: 1, name: 'Edited task', stage: 'draft', tenantId: 'B' },
      { id: 2, name: 'Second task', stage: 'draft', tenantId: 'B' },
    ];
    expect(await rows()).toEqual(final);
    const finalList = await agent()
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(finalList.status).toBe(200);
    expect(finalList.body.data).toEqual(final);
  });
});
