import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey } from '../../access-control/config-store';
import { draftLegacyAccessConfig } from '../../access-control/legacy-config';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated legacy claims with database constraint failures', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;
  let token: string;
  let userId: number;
  const role = 'claim-constraint-editor';
  const password = 'claim-constraint-test-password';
  const collectionName = 'claimConstraintTasks';
  const agent = () =>
    app
      .agent()
      .set('Authorization', `Bearer ${token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .set('X-Tenant-Id', 'B');
  const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });

  beforeEach(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
    });
    userId = user.get('id');
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
        fields: [
          { name: 'name', type: 'string' },
          { name: 'code', type: 'string', unique: true },
        ],
      },
    });
    const grant = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'code', 'tenantId'] },
          { name: 'create', fields: ['name', 'code'] },
          { name: 'update', fields: ['name', 'code'] },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', grant.get('id')).find({});
    expect(
      actions
        .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'create', fields: ['code', 'name'] },
      { name: 'list', fields: ['code', 'id', 'name', 'tenantId'] },
      { name: 'update', fields: ['code', 'name'] },
    ]);
    const collection = app.db.getCollection(collectionName);
    expect(await rows()).toEqual([]);
    // Only these harmless pre-migration fixtures are unassigned; requests create normal owned rows.
    // 仅这些无害迁移前夹具未归属；正常请求新增记录始终归属当前租户。
    await collection.model.bulkCreate([
      { id: 1, name: 'Legacy first', code: 'First', tenantId: null },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    const metadata = resolveModelMetadata(collection, {
      resolveCollectionKey: (target) =>
        accessCollectionKey({ dataSourceKey: 'main', collectionKey: target.options.key, collectionName: target.name }),
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
    expect(String(signedIn.body.data.user.id)).toBe(String(userId));
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    token = signedIn.body.data.token;
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(userId));
    expect(
      (
        await agent()
          .resource(collectionName)
          .create({ values: { name: 'Owned reserved', code: 'Reserved' } })
      ).status,
    ).toBe(200);
    expect(await rows()).toEqual([
      { id: 1, name: 'Legacy first', code: 'First', tenantId: null },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
    const visible = await agent()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'code', 'tenantId'], sort: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([
      { id: 1, name: 'Legacy first', code: 'First', tenantId: null },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // A rejected database save must not commit the server-owned legacy claim separately.
  // 数据库保存失败不能单独提交服务端历史认领。
  it('keeps a failed first edit unclaimed and permits a valid authenticated retry', async () => {
    const failed = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Failed claim', code: 'Reserved', tenantId: null } });
    expect(failed.status).toBe(400);
    expect(failed.body.errors[0].message).toBe('code must be unique');
    expect(await rows()).toEqual([
      { id: 1, name: 'Legacy first', code: 'First', tenantId: null },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
    const retry = await agent()
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Valid claim', code: 'Claimed', tenantId: null } });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Valid claim', code: 'Claimed', tenantId: 'B' },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
  });

  // A later SQL constraint failure must undo the earlier row and its claim in the same batch.
  // 后行 SQL 约束失败必须回滚同批前行内容及认领。
  it('rolls back an earlier persisted claim when the later batch row violates uniqueness', async () => {
    let committed = 0;
    const observed: { transaction: Transaction; rows: unknown; actor: unknown }[] = [];
    app.db.on(`${collectionName}.afterUpdateWithAssociations`, async (_record, options) => {
      const transaction: Transaction = options.transaction;
      observed.push({
        transaction,
        rows: await app.db
          .getCollection(collectionName)
          .model.findAll({ raw: true, order: [['id', 'ASC']], transaction }),
        actor: {
          userId: options.context.state.currentUser.id,
          role: options.context.state.currentRole,
          tenantId: options.context.state.currentTenantId,
        },
      });
      transaction.afterCommit(() => {
        committed++;
      });
    });
    const failed = await agent()
      .post('/claimConstraintTasks:update?filterByTk[]=2&filterByTk[]=1')
      .send({ name: 'Failed batch claim', code: 'Batch collision', tenantId: null });
    expect(failed.status).toBe(400);
    expect(failed.body.errors[0].message).toBe('code must be unique');
    expect(observed).toHaveLength(1);
    expect(observed[0].rows).toEqual([
      { id: 1, name: 'Failed batch claim', code: 'Batch collision', tenantId: 'B' },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
    expect(observed[0].actor).toEqual({ userId, role, tenantId: 'B' });
    expect(observed[0].transaction.finished).toBe('rollback');
    expect(committed).toBe(0);
    expect(await rows()).toEqual([
      { id: 1, name: 'Legacy first', code: 'First', tenantId: null },
      { id: 2, name: 'Legacy second', code: 'Second', tenantId: null },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
    const retry = await agent()
      .post('/claimConstraintTasks:update?filterByTk[]=2&filterByTk[]=1')
      .send({ name: 'Valid batch claim', tenantId: null });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual({ keys: [1, 2], affected: 2 });
    expect(observed).toHaveLength(3);
    expect(observed[1].transaction).not.toBe(observed[0].transaction);
    expect(observed[2].transaction).toBe(observed[1].transaction);
    expect(observed[1].transaction.finished).toBe('commit');
    expect(observed[1].actor).toEqual({ userId, role, tenantId: 'B' });
    expect(observed[2].actor).toEqual({ userId, role, tenantId: 'B' });
    expect(committed).toBe(2);
    expect(await rows()).toEqual([
      { id: 1, name: 'Valid batch claim', code: 'First', tenantId: 'B' },
      { id: 2, name: 'Valid batch claim', code: 'Second', tenantId: 'B' },
      { id: 3, name: 'Owned reserved', code: 'Reserved', tenantId: 'B' },
    ]);
  });
});
