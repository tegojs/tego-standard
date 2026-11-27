import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import ApiLogsPlugin from '../../../../../plugin-api-logs/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business update API logs', () => {
  // Update logs must retain real before/after values and exclude rejected or unchanged writes.
  // 更新日志必须保留真实前后值，并排除拒绝或未变化的写入。
  it('preserves update history across selected writes, rejection and recovery', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [ApiLogsPlugin, { name: 'api-logs', packageName: '@tachybase/plugin-api-logs', workspaceSource: true }],
        ],
      });
      const plugin = app.pm.get('api-logs') as ApiLogsPlugin;
      expect(plugin).toBeInstanceOf(ApiLogsPlugin);
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      const role = 'logged-update-editor';
      const deniedRole = 'logged-update-without-actions';
      for (const name of [role, deniedRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'logged-update-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role, deniedRole], tenants: ['B'], defaultTenantId: 'B' },
      });
      const collectionName = 'loggedUpdateTasks';
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
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
            { name: 'create', fields: ['name'] },
            { name: 'update', fields: ['name'] },
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
          ],
        },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
        { name: 'update', fields: ['name'] },
      ]);
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      await registry.store.save(
        identity,
        {
          ...configFor({
            type: 'all',
            children: [
              ownerCondition,
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
              {
                type: 'compare',
                operator: 'ne',
                left: { type: 'field', path: 'name' },
                right: { type: 'literal', value: 'Excluded task' },
              },
            ],
          }),
          revision: 0,
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      let selected = false;
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
      );
      await app.db.getRepository('apiLogsConfig').create({
        values: { resourceName: collectionName, action: 'update', apiConfig: true },
      });
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      await plugin.apiFilter.load();
      expect(plugin.apiFilter.check(collectionName, 'update')).toBe(true);
      const agent = (currentRole = role) =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', currentRole)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      const logs = async () =>
        (
          await app.db.getRepository('apiLogs').find({ filter: { collectionName }, appends: ['changes'], sort: ['id'] })
        ).map((log) => ({
          action: log.get('action'),
          recordId: log.get('recordId'),
          userId: log.get('userId'),
          changes: log.get('changes').map((change) => ({
            field: change.get('field').name,
            before: change.get('before'),
            after: change.get('after'),
          })),
        }));
      expect(await rows()).toEqual([]);
      expect(await logs()).toEqual([]);
      const created = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Draft task' } });
      expect(created.status).toBe(200);
      expect(await rows()).toEqual([{ id: 1, name: 'Draft task', tenantId: 'B' }]);
      expect(await logs()).toEqual([]);
      const excludedSource = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Excluded task' } });
      expect(excludedSource.status).toBe(200);
      const baseline = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Legacy edit' } });
      expect(baseline.status).toBe(200);
      expect(await rows()).toEqual([
        { id: 1, name: 'Legacy edit', tenantId: 'B' },
        { id: 2, name: 'Excluded task', tenantId: 'B' },
      ]);
      const expectedLogs = [
        {
          action: 'update',
          recordId: '1',
          userId: user.id,
          changes: [{ field: 'name', before: 'Draft task', after: 'Legacy edit' }],
        },
      ];
      await vi.waitFor(async () => expect(await logs()).toEqual(expectedLogs), { timeout: 3000, interval: 50 });
      selected = true;
      const updated = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Selected edit' } });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toEqual({ keys: [1], affected: 1 });
      const expectedRows = [
        { id: 1, name: 'Selected edit', tenantId: 'B' },
        { id: 2, name: 'Excluded task', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expectedRows);
      expectedLogs.push({
        action: 'update',
        recordId: '1',
        userId: user.id,
        changes: [{ field: 'name', before: 'Legacy edit', after: 'Selected edit' }],
      });
      await vi.waitFor(async () => expect(await logs()).toEqual(expectedLogs), { timeout: 3000, interval: 50 });
      const unchanged = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Selected edit' } });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body.data).toEqual({ keys: [], affected: 0 });
      expect(await rows()).toEqual(expectedRows);
      expect(await logs()).toEqual(expectedLogs);
      const denied = await agent(deniedRole)
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Denied edit' } });
      expect(denied.status).toBe(403);
      const excluded = await agent()
        .resource(collectionName)
        .update({ filterByTk: 2, values: { name: 'Excluded edit' } });
      expect(excluded.status).toBe(403);
      expect(await rows()).toEqual(expectedRows);
      expect(await logs()).toEqual(expectedLogs);
      const rejected: { transaction: Transaction; rows: unknown }[] = [];
      app.db.on(`${collectionName}.afterUpdateWithAssociations`, async (record, options) => {
        if (record.get('name') !== 'Rejected edit') return;
        const transaction: Transaction = options.transaction;
        rejected.push({
          transaction,
          rows: await app.db.getCollection(collectionName).model.findAll({
            raw: true,
            order: [['id', 'ASC']],
            transaction,
          }),
        });
        throw new Error('Logged update rejected after business SQL');
      });
      const rolledBack = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Rejected edit' } });
      expect(rolledBack.status).toBe(500);
      expect(rolledBack.body.errors[0].message).toContain('Logged update rejected after business SQL');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].rows).toEqual([
        { id: 1, name: 'Rejected edit', tenantId: 'B' },
        { id: 2, name: 'Excluded task', tenantId: 'B' },
      ]);
      expect(rejected[0].transaction.finished).toBe('rollback');
      expect(await rows()).toEqual(expectedRows);
      expect(await logs()).toEqual(expectedLogs);
      const recovered = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Recovery edit' } });
      expect(recovered.status).toBe(200);
      expect(recovered.body.data).toEqual({ keys: [1], affected: 1 });
      expectedRows[0].name = 'Recovery edit';
      expectedLogs.push({
        action: 'update',
        recordId: '1',
        userId: user.id,
        changes: [{ field: 'name', before: 'Selected edit', after: 'Recovery edit' }],
      });
      expect(await rows()).toEqual(expectedRows);
      await vi.waitFor(async () => expect(await logs()).toEqual(expectedLogs), { timeout: 3000, interval: 50 });
      const listed = await agent().resource(collectionName).list();
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([{ id: 1, name: 'Recovery edit', tenantId: 'B' }]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
