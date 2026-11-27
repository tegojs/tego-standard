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

describe.skipIf(!coreEntry)('authenticated first-edit legacy ownership', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Visibility must not permit a claim; a permitted first edit must claim before normal deletion.
  // 可见性不能允许认领；获准的首次编辑必须先认领，随后才能按普通归属删除。
  it.each([false, true])('honors persisted legacy editing=%s through real authenticated requests', async (editable) => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'legacy-task-editor';
    const password = 'legacy-claim-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    const collectionName = 'legacyClaimTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        legacyDataTenantIds: ['B'],
        allowEditingLegacyData: editable,
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
          { name: 'create', fields: ['name'] },
          { name: 'update', fields: ['name'] },
          { name: 'destroy' },
        ],
      },
    });
    const collection = app.db.getCollection(collectionName);
    const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    // A harmless unassigned fixture models pre-migration data; no request creates it as unassigned.
    // 无害未归属夹具代表迁移前历史数据，不通过请求制造无归属新增。
    await collection.model.bulkCreate([{ id: 1, name: 'Legacy draft', tenantId: null }]);
    expect(await rows()).toEqual([{ id: 1, name: 'Legacy draft', tenantId: null }]);
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
    const visible = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'], sort: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([{ id: 1, name: 'Legacy draft', tenantId: null }]);
    const directDelete = await agent().resource(collectionName).destroy({ filterByTk: 1 });
    expect(directDelete.status).toBe(403);
    expect(directDelete.body.errors[0].message).toBe(
      editable ? 'Unassigned legacy records cannot be deleted' : 'Legacy record is visible but cannot be edited',
    );
    expect(await rows()).toEqual([{ id: 1, name: 'Legacy draft', tenantId: null }]);
    const edit = await agent()
      .resource(collectionName)
      .update({
        filterByTk: 1,
        values: { name: 'Claimed task', tenantId: null },
      });
    if (editable) {
      expect(edit.status).toBe(200);
      expect(edit.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Claimed task', tenantId: 'B' }]);
      const removed = await agent().resource(collectionName).destroy({ filterByTk: 1 });
      expect(removed.status).toBe(200);
      expect(removed.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([]);
    } else {
      expect(edit.status).toBe(403);
      expect(edit.body.errors[0].message).toBe('Legacy record is visible but cannot be edited');
      expect(await rows()).toEqual([{ id: 1, name: 'Legacy draft', tenantId: null }]);
    }
    const owned = await agent()
      .resource(collectionName)
      .create({ values: { name: 'New owned task' } });
    expect(owned.status).toBe(200);
    const editedOwned = await agent()
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Edited owned task' } });
    expect(editedOwned.status).toBe(200);
    expect(editedOwned.body.data).toEqual({ keys: [2], affected: 1 });
    expect(await rows()).toEqual(
      editable
        ? [{ id: 2, name: 'Edited owned task', tenantId: 'B' }]
        : [
            { id: 1, name: 'Legacy draft', tenantId: null },
            { id: 2, name: 'Edited owned task', tenantId: 'B' },
          ],
    );
  });
});
