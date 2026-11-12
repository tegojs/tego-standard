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

describe.skipIf(!coreEntry)('authenticated business destroy API logs', () => {
  // Batch delete logs must retain each preimage and exclude rejected or rolled-back deletions.
  // 批量删除日志必须保留每行原值，并排除被拒绝或回滚的删除。
  it('preserves batch delete preimages across rejection, rollback and recovery', async () => {
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
      const role = 'logged-destroy-editor';
      const deniedRole = 'logged-destroy-without-actions';
      for (const name of [role, deniedRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'logged-destroy-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role, deniedRole], tenants: ['B'], defaultTenantId: 'B' },
      });
      const collectionName = 'loggedDestroyTasks';
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
            { name: 'destroy', fields: ['name'] },
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
        { name: 'destroy', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
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
        values: { resourceName: collectionName, action: 'destroy', apiConfig: true },
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
      expect(plugin.apiFilter.check(collectionName, 'destroy')).toBe(true);
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
      const rows = (transaction?: Transaction) =>
        app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']], transaction });
      const logs = async () =>
        (
          await app.db
            .getRepository('apiLogs')
            .find({ filter: { collectionName }, appends: ['changes'], sort: ['recordId'] })
        ).map((log) => ({
          action: log.get('action'),
          recordId: log.get('recordId'),
          userId: log.get('userId'),
          changes: log
            .get('changes')
            .filter((change) => change.get('field').name === 'name')
            .map((change) => ({ before: change.get('before'), after: change.get('after') })),
        }));
      expect(await rows()).toEqual([]);
      expect(await logs()).toEqual([]);
      for (const name of ['Legacy removal', 'First removal', 'Second removal', 'Excluded task']) {
        const created = await agent().resource(collectionName).create({ values: { name } });
        expect(created.status).toBe(200);
      }
      const initial = [
        { id: 1, name: 'Legacy removal', tenantId: 'B' },
        { id: 2, name: 'First removal', tenantId: 'B' },
        { id: 3, name: 'Second removal', tenantId: 'B' },
        { id: 4, name: 'Excluded task', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(initial);
      expect(await logs()).toEqual([]);
      const baseline = await agent().resource(collectionName).destroy({ filterByTk: 1 });
      expect(baseline.status).toBe(200);
      const remaining = [
        { id: 2, name: 'First removal', tenantId: 'B' },
        { id: 3, name: 'Second removal', tenantId: 'B' },
        { id: 4, name: 'Excluded task', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(remaining);
      const baselineLog = {
        action: 'destroy',
        recordId: '1',
        userId: user.id,
        changes: [{ before: 'Legacy removal', after: null }],
      };
      await vi.waitFor(async () => expect(await logs()).toEqual([baselineLog]), { timeout: 3000, interval: 50 });
      selected = true;
      const denied = await agent(deniedRole).post(`/${collectionName}:destroy?filterByTk[]=2&filterByTk[]=3`);
      expect(denied.status).toBe(403);
      const mixed = await agent().post(`/${collectionName}:destroy?filterByTk[]=2&filterByTk[]=4`);
      expect(mixed.status).toBe(403);
      expect(await rows()).toEqual(remaining);
      expect(await logs()).toEqual([baselineLog]);
      let reject = true;
      const late: { transaction: Transaction; rows: unknown }[] = [];
      app.db.on(`${collectionName}.afterDestroy`, async (record, options) => {
        if (record.get('id') !== 3) return;
        const transaction: Transaction = options.transaction;
        late.push({ transaction, rows: await rows(transaction) });
        if (reject) throw new Error('Logged batch deletion rejected after business SQL');
      });
      const destroy = () => agent().post(`/${collectionName}:destroy?filterByTk[]=2&filterByTk[]=3`);
      const failed = await destroy();
      expect(failed.status).toBe(500);
      expect(failed.body.errors[0].message).toContain('Logged batch deletion rejected after business SQL');
      expect(late).toHaveLength(1);
      expect(late[0].rows).toEqual([{ id: 4, name: 'Excluded task', tenantId: 'B' }]);
      expect(late[0].transaction.finished).toBe('rollback');
      expect(await rows()).toEqual(remaining);
      expect(await logs()).toEqual([baselineLog]);
      reject = false;
      const recovered = await destroy();
      expect(recovered.status).toBe(200);
      expect(recovered.body.data).toEqual({ keys: [2, 3], affected: 2 });
      expect(late).toHaveLength(2);
      expect(late[1].rows).toEqual([{ id: 4, name: 'Excluded task', tenantId: 'B' }]);
      expect(late[1].transaction.finished).toBe('commit');
      expect(late[1].transaction).not.toBe(late[0].transaction);
      expect(await rows()).toEqual([{ id: 4, name: 'Excluded task', tenantId: 'B' }]);
      await vi.waitFor(
        async () =>
          expect(await logs()).toEqual([
            baselineLog,
            {
              action: 'destroy',
              recordId: '2',
              userId: user.id,
              changes: [{ before: 'First removal', after: null }],
            },
            {
              action: 'destroy',
              recordId: '3',
              userId: user.id,
              changes: [{ before: 'Second removal', after: null }],
            },
          ]),
        { timeout: 3000, interval: 50 },
      );
      const listed = await agent().resource(collectionName).list();
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
