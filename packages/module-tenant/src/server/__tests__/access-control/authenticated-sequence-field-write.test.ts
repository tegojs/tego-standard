import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import SequenceFieldPlugin from '../../../../../plugin-field-sequence/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated generated sequence business writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Losing the writer transaction burns a sequence on denial; filtering persisted defaults loses its code.
  // 写入器丢失原事务会在拒绝时消耗编号；丢弃服务端生成值会丢失业务编号。
  it('preserves generated codes and rolls back the counter when G rejects a creation', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          SequenceFieldPlugin,
          { name: 'sequence-field', packageName: '@tachybase/plugin-field-sequence', workspaceSource: true },
        ],
      ],
    });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'numbered-task-editor';
    const password = 'numbered-task-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'numberedTasks';
    const collection = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          {
            name: 'code',
            type: 'sequence',
            inputable: false,
            patterns: [
              { type: 'string', options: { value: 'TASK-' } },
              { type: 'integer', options: { key: 42, start: 1, digits: 3 } },
            ],
          },
        ],
      },
    });
    const runtime = app.db.getCollection(collectionName);
    expect(runtime.getField('code').type).toBe('sequence');
    expect(runtime.getField('code').options.inputable).toBe(false);
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'code', 'tenantId'] },
          { name: 'create', fields: ['name'] },
          { name: 'update', fields: ['name'] },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(
      actions
        .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name'] },
      { name: 'list', fields: ['code', 'id', 'name', 'tenantId'] },
      { name: 'update', fields: ['name'] },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor({
      type: 'all',
      children: [
        ownerCondition,
        {
          type: 'compare',
          operator: 'ne',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Blocked task' },
        },
      ],
    });
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: config.rules.map((rule) => ({
          ...rule,
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
                right: { type: 'literal', value: role },
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
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ id: userId, hasPassword: true });
    const rows = () => runtime.model.findAll({ raw: true, order: [['id', 'ASC']] });
    const counters = () =>
      app.db.getCollection('sequences').model.findAll({
        raw: true,
        where: { collection: collectionName },
        order: [['id', 'ASC']],
      });
    expect(await rows()).toEqual([]);
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'First task' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'First task', code: 'TASK-001', tenantId: 'B' }]);
    const counterBefore = await counters();
    expect(counterBefore).toHaveLength(1);
    expect(counterBefore[0]).toMatchObject({ collection: collectionName, field: 'code', key: 42, current: 1 });
    const denied = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Blocked task' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual([{ id: 1, name: 'First task', code: 'TASK-001', tenantId: 'B' }]);
    expect(await counters()).toEqual(counterBefore);
    const second = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Second task' } });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ keys: [2], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'First task', code: 'TASK-001', tenantId: 'B' },
      { id: 2, name: 'Second task', code: 'TASK-002', tenantId: 'B' },
    ]);
    const counterAfter = await counters();
    expect(counterAfter).toHaveLength(1);
    expect(counterAfter[0]).toMatchObject({ collection: collectionName, field: 'code', key: 42, current: 2 });
    const updated = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Edited task' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    const expected = [
      { id: 1, name: 'Edited task', code: 'TASK-001', tenantId: 'B' },
      { id: 2, name: 'Second task', code: 'TASK-002', tenantId: 'B' },
    ];
    expect(await rows()).toEqual(expected);
    expect(await counters()).toEqual(counterAfter);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'code', 'tenantId'], sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(expected);
  });
});
