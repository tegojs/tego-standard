import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated ordinary JSON business fields', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let token: string;
  const collectionName = 'structuredTasks';
  const role = 'structured-task-editor';
  const fields = ['id', 'name', 'details', 'tenantId'];
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');
  const rows = async () => {
    const stored = await app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    // SQLite raw JSON is text; decode storage without using presentation getters.
    // SQLite 原始 JSON 是文本，仅解码存储值，不调用展示 getter。
    return stored.map((row) => ({
      ...row,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
    }));
  };

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const account = 'structured-task-user';
    const password = 'structured-task-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: account, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
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
          { name: 'details', type: 'json' },
        ],
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields },
          { name: 'create', fields: ['name', 'details'] },
          { name: 'update', fields: ['name', 'details'] },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(
      actions
        .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['details', 'name'] },
      { name: 'list', fields: ['details', 'id', 'name', 'tenantId'] },
      { name: 'update', fields: ['details', 'name'] },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: [
          {
            ...config.rules[0],
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
          },
        ],
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
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data.id).toBe(userId);
    expect(await rows()).toEqual([]);
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Root projection/cloning must preserve JSON atoms, not route them as association writes or merge old content.
  // 根字段投影与复制必须保留 JSON 值，不得误走关联写入或合并旧内容。
  it('replaces an ordinary nested object and explicitly clears it without changing ownership', async () => {
    const created = await agent()
      .resource(collectionName)
      .create({
        values: {
          name: 'Checklist task',
          details: { checklist: [{ title: 'Review', done: false }], settings: { attempts: 0, note: null, label: '' } },
        },
      });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      {
        id: 1,
        name: 'Checklist task',
        details: { checklist: [{ title: 'Review', done: false }], settings: { attempts: 0, note: null, label: '' } },
        tenantId: 'B',
      },
    ]);
    const updated = await agent()
      .resource(collectionName)
      .update({
        filterByTk: 1,
        values: { details: { checklist: [], settings: { attempts: 2 } } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    const replaced = [
      { id: 1, name: 'Checklist task', details: { checklist: [], settings: { attempts: 2 } }, tenantId: 'B' },
    ];
    expect(await rows()).toEqual(replaced);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(replaced);
    const cleared = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { details: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Checklist task', details: null, tenantId: 'B' }]);
    const renamed = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Cleared task' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Cleared task', details: null, tenantId: 'B' }]);
  });

  it('preserves an empty JSON array on omitted-field edits and later saves a replacement array', async () => {
    const created = await agent()
      .resource(collectionName)
      .create({
        values: { name: 'Steps task', details: [{ title: 'Plan', done: false }, 0, null, []] },
      });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Steps task', details: [{ title: 'Plan', done: false }, 0, null, []], tenantId: 'B' },
    ]);
    const cleared = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { details: [] } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Steps task', details: [], tenantId: 'B' }]);
    const renamed = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Empty steps task' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Empty steps task', details: [], tenantId: 'B' }]);
    const updated = await agent()
      .resource(collectionName)
      .update({
        filterByTk: 1,
        values: { details: [{ title: 'Done', done: true }] },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
    const final = [{ id: 1, name: 'Empty steps task', details: [{ title: 'Done', done: true }], tenantId: 'B' }];
    expect(await rows()).toEqual(final);
    const listed = await agent()
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(final);
  });
});
