import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey } from '../../access-control/config-store';
import { draftLegacyAccessConfig } from '../../access-control/legacy-config';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated scalar legacy no-op writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // An unconditional claim patch would turn an unchanged form into an ownership change.
  // 无条件认领补丁会把未变化的表单错误地变成归属修改。
  it.each([false, true])('claims only genuinely edited rows (batch=%s)', async (batch) => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'legacy-noop-editor';
    const password = 'legacy-noop-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const collectionName = 'legacyNoopTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        legacyDataTenantIds: ['B'],
        allowEditingLegacyData: true,
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
          { name: 'create', fields: ['name'] },
          { name: 'update', fields: ['name'] },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(actions.map((action) => action.get('name')).sort()).toEqual(['create', 'list', 'update']);
    for (const action of actions)
      expect([...action.get('fields')].sort()).toEqual(
        action.get('name') === 'list' ? ['id', 'name', 'tenantId'] : ['name'],
      );
    const collection = app.db.getCollection(collectionName);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    // Only harmless migration fixtures are unassigned; normal requests must create owned data.
    // 仅无害迁移前夹具未归属，正常请求新增必须有真实归属。
    await collection.model.bulkCreate([
      { id: 1, name: 'Same task', tenantId: null },
      { id: 2, name: 'Different task', tenantId: null },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    const metadata = resolveModelMetadata(collection, {
      resolveCollectionKey: (target) =>
        accessCollectionKey({
          dataSourceKey: 'main',
          collectionKey: target.options.key,
          collectionName: target.name,
        }),
    });
    const config = draftLegacyAccessConfig(
      {
        tenancy: collection.options.tenancy,
        legacyDataTenantIds: collection.options.legacyDataTenantIds,
        allowEditingLegacyData: collection.options.allowEditingLegacyData,
      },
      metadata,
    );
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    await registry.store.save(
      identity,
      {
        ...config,
        rules: config.rules.map((rule) => ({
          ...rule,
          subject: {
            type: 'all',
            children: [
              rule.subject,
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(user.get('id')) },
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
      { userId: user.get('id') },
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
    expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${signedIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(user.get('id')));
    const created = await agent()
      .resource(collectionName)
      .create({ values: { name: 'Owned task' } });
    expect(created.status).toBe(200);
    const visible = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'], sort: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([
      { id: 1, name: 'Same task', tenantId: null },
      { id: 2, name: 'Different task', tenantId: null },
      { id: 3, name: 'Owned task', tenantId: 'B' },
    ]);
    const unchanged = batch
      ? await agent()
          .post(`/${collectionName}:update?filterByTk[]=2&filterByTk[]=1`)
          .send({ name: 'Same task', tenantId: null })
      : await agent()
          .resource(collectionName)
          .update({ filterByTk: 1, values: { name: 'Same task', tenantId: null } });
    expect(unchanged.status).toBe(200);
    // Ownership is the primary assertion, independently of the success receipt.
    // 先独立核对持久归属，再核成功回执。
    expect(await rows()).toEqual([
      { id: 1, name: 'Same task', tenantId: null },
      { id: 2, name: batch ? 'Same task' : 'Different task', tenantId: batch ? 'B' : null },
      { id: 3, name: 'Owned task', tenantId: 'B' },
    ]);
    expect(unchanged.body.data).toEqual(batch ? { keys: [2], affected: 1 } : { keys: [], affected: 0 });
    const claimed = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Actually edited', tenantId: null } });
    expect(claimed.status).toBe(200);
    expect(claimed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Actually edited', tenantId: 'B' },
      { id: 2, name: batch ? 'Same task' : 'Different task', tenantId: batch ? 'B' : null },
      { id: 3, name: 'Owned task', tenantId: 'B' },
    ]);
  });
});
