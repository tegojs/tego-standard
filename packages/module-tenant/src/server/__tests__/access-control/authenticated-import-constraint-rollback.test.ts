import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import ImportPlugin from '../../../../../plugin-action-import/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;
const xlsx = createRequire(new URL('../../../../../plugin-action-import/package.json', import.meta.url))(
  'node-xlsx',
) as {
  build(data: Array<{ name: string; data: unknown[][] }>): Buffer;
};

describe.skipIf(!coreEntry)('authenticated import database constraints', () => {
  // Catch partial commits or lost transaction binding when a later real business uniqueness check fails.
  // 后行真实唯一约束失败须回滚前行，不能捕获错误后部分提交或丢失整份文件的事务绑定。
  it('rolls back an earlier inserted order and accepts the corrected workbook under the same login', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const role = 'constraint-business-importer';
    const name = 'importBusinessOrders';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [ImportPlugin],
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const password = 'constraint-business-import-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'code', type: 'string', unique: true },
            { name: 'amount', type: 'integer' },
          ],
        },
      });
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
      const actions = [
        { name: 'create', fields: ['amount', 'code', 'name'] },
        { name: 'importXlsx', fields: ['amount', 'code', 'name'] },
        { name: 'list', fields: ['amount', 'code', 'id', 'name', 'tenantId'] },
      ];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: { dataSourceKey: 'main', roleName: role, name, usingActionsConfig: true, actions },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(actions);
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = () =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = (transaction?: Transaction) =>
        app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']], transaction });
      expect(await rows()).toEqual([]);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      const config = configFor(ownerCondition);
      for (const rule of config.rules)
        rule.subject = {
          type: 'all',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'user.id' },
              right: { type: 'literal', value: String(user.id) },
            },
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'role.name' },
              right: { type: 'literal', value: role },
            },
          ],
        };
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [identity.collectionKey]),
      );
      const baseline = await agent()
        .resource(name)
        .create({ values: { name: 'Existing order', code: 'RESERVED', amount: 7 } });
      expect(baseline.status).toBe(200);
      expect(baseline.body.data).toEqual({ keys: [1], affected: 1 });
      const original = { id: 1, name: 'Existing order', code: 'RESERVED', amount: 7, tenantId: 'B' };
      expect(await rows()).toEqual([original]);
      let committed = 0;
      const observed: Array<{ transaction: Transaction; rows: unknown; actor: unknown }> = [];
      // Observe real persisted rows in the caller's transaction; the observer never throws or writes.
      // 只读观察调用方真实事务内的完整行，不抛错、注入失败或修改事务/业务数据。
      app.db.on(name + '.afterCreateWithAssociations', async (_record, options) => {
        const transaction: Transaction = options.transaction;
        observed.push({
          transaction,
          rows: await rows(transaction),
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
      const upload = (lastCode: string) =>
        agent()
          .post('/' + name + ':importXlsx')
          .attach(
            'file',
            xlsx.build([
              {
                name: 'Orders',
                data: [
                  ['Name', 'Code', 'Amount'],
                  ['Earlier order', 'NEW-1', 10],
                  ['Later order', lastCode, 20],
                ],
              },
            ]),
            { filename: 'business-orders.xlsx' },
          )
          .field(
            'columns',
            JSON.stringify([
              { dataIndex: ['name'], defaultTitle: 'Name' },
              { dataIndex: ['code'], defaultTitle: 'Code' },
              { dataIndex: ['amount'], defaultTitle: 'Amount' },
            ]),
          );
      const failed = await upload('RESERVED');
      expect(failed.status).toBe(400);
      expect(failed.body.errors[0].message).toBe('code must be unique');
      expect(failed.body.meta?.successCount).toBeUndefined();
      expect(observed).toHaveLength(1);
      expect(observed[0].actor).toEqual({ userId: user.id, role, tenantId: 'B' });
      expect(observed[0].rows).toEqual([
        original,
        { id: 2, name: 'Earlier order', code: 'NEW-1', amount: 10, tenantId: 'B' },
      ]);
      expect(committed).toBe(0);
      expect(await rows()).toEqual([original]);
      const beforeRetry = await agent()
        .resource(name)
        .list({ fields: ['id', 'name', 'code', 'amount', 'tenantId'], sort: ['id'] });
      expect(beforeRetry.status).toBe(200);
      expect(beforeRetry.body.data).toEqual([original]);
      observed.length = 0;
      const retry = await upload('NEW-2');
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ data: [], meta: { successCount: 2, failureCount: 0 } });
      expect(observed).toHaveLength(2);
      expect(observed[0].transaction).toBe(observed[1].transaction);
      expect(committed).toBe(2);
      const expected = [
        original,
        { id: 2, name: 'Earlier order', code: 'NEW-1', amount: 10, tenantId: 'B' },
        { id: 3, name: 'Later order', code: 'NEW-2', amount: 20, tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expected);
      const listed = await agent()
        .resource(name)
        .list({ fields: ['id', 'name', 'code', 'amount', 'tenantId'], sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expected);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
