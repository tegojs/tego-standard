import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import ApiLogsPlugin from '../../../../../plugin-api-logs/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business create API logs', () => {
  // Selecting the new executor must preserve an enabled create log and its actual record key.
  // 选中新执行器后，已启用的新增日志仍须关联实际业务主键。
  it.each(['id', 'taskKey', 'affected'])('preserves create log keys and rejected writes (key: %s)', async (keyName) => {
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
      const role = 'logged-business-editor';
      const deniedRole = 'logged-business-without-actions';
      for (const name of [role, deniedRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'logged-business-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role, deniedRole], tenants: ['B'], defaultTenantId: 'B' },
      });
      const collectionName = 'loggedBusinessTasks';
      const textualKey = keyName !== 'id';
      const keys = textualKey ? ['001', '1', '2'] : [1, 2, 3];
      const values = (name: string, key: string | number) => ({ name, ...(textualKey ? { [keyName]: key } : {}) });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          ...(textualKey ? { autoGenId: false, filterTargetKey: keyName } : {}),
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            ...(textualKey ? [{ name: keyName, type: 'string', primaryKey: true, allowNull: false }] : []),
            { name: 'name', type: 'string' },
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
            { name: 'create', fields: textualKey ? ['name', keyName] : ['name'] },
            { name: 'list', fields: [keyName, 'name', 'tenantId'] },
          ],
        },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: textualKey ? ['name', keyName].sort() : ['name'] },
        { name: 'list', fields: [keyName, 'name', 'tenantId'].sort() },
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
        values: { resourceName: collectionName, action: 'create', apiConfig: true },
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
      expect(plugin.apiFilter).toBeTruthy();
      await plugin.apiFilter.load();
      expect(plugin.apiFilter.check(collectionName, 'create')).toBe(true);
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
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [[keyName, 'ASC']] });
      const logs = async () =>
        (
          await app.db.getRepository('apiLogs').find({ filter: { collectionName }, appends: ['changes'], sort: ['id'] })
        ).map((log) => ({
          action: log.get('action'),
          recordId: log.get('recordId'),
          userId: log.get('userId'),
          changes: log
            .get('changes')
            .filter((change) => change.get('field').name === 'name')
            .map((change) => ({
              before: change.get('before'),
              after: change.get('after'),
            })),
        }));
      expect(await rows()).toEqual([]);
      expect(await logs()).toEqual([]);
      const baseline = await agent()
        .resource(collectionName)
        .create({ values: values('Legacy logged task', keys[0]) });
      expect(baseline.status).toBe(200);
      expect(await rows()).toEqual([{ [keyName]: keys[0], name: 'Legacy logged task', tenantId: 'B' }]);
      const baselineLog = {
        action: 'create',
        recordId: String(keys[0]),
        userId: user.id,
        changes: [{ before: null, after: 'Legacy logged task' }],
      };
      await vi.waitFor(async () => expect(await logs()).toEqual([baselineLog]), { timeout: 3000, interval: 50 });
      selected = true;
      const created = await agent()
        .resource(collectionName)
        .create({ values: values('Selected logged task', keys[1]) });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [keys[1]], affected: 1 });
      const expectedRows = [
        { [keyName]: keys[0], name: 'Legacy logged task', tenantId: 'B' },
        { [keyName]: keys[1], name: 'Selected logged task', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expectedRows);
      const expectedLogs = [
        baselineLog,
        {
          action: 'create',
          recordId: String(keys[1]),
          userId: user.id,
          changes: [{ before: null, after: 'Selected logged task' }],
        },
      ];
      await vi.waitFor(async () => expect(await logs()).toEqual(expectedLogs), { timeout: 3000, interval: 50 });
      const denied = await agent(deniedRole)
        .resource(collectionName)
        .create({ values: values('Denied task', 'denied') });
      expect(denied.status).toBe(403);
      const excluded = await agent()
        .resource(collectionName)
        .create({ values: values('Excluded task', 'excluded') });
      expect(excluded.status).toBe(403);
      expect(await rows()).toEqual(expectedRows);
      expect(await logs()).toEqual(expectedLogs);
      const recovered = await agent()
        .resource(collectionName)
        .create({ values: values('Recovery task', keys[2]) });
      expect(recovered.status).toBe(200);
      expect(recovered.body.data).toEqual({ keys: [keys[2]], affected: 1 });
      expectedRows.push({ [keyName]: keys[2], name: 'Recovery task', tenantId: 'B' });
      expectedLogs.push({
        action: 'create',
        recordId: String(keys[2]),
        userId: user.id,
        changes: [{ before: null, after: 'Recovery task' }],
      });
      expect(await rows()).toEqual(expectedRows);
      await vi.waitFor(async () => expect(await logs()).toEqual(expectedLogs), { timeout: 3000, interval: 50 });
      const listed = await agent()
        .resource(collectionName)
        .list({ sort: [keyName] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expectedRows);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
