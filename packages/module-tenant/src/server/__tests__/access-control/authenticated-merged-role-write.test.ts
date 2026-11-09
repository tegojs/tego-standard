import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { Transaction } from '@tego/server';

import PluginSubAccountsServer from '../../../../../plugin-sub-accounts/src/server';
import { MergeRoleModel } from '../../../../../plugin-sub-accounts/src/server/model/MergeRoleModel';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated merged role business writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
    vi.restoreAllMocks();
  });

  // Losing a source action rejects valid writes; losing finite fields admits an ungranted memo.
  // 丢失来源动作会拒绝正常写入，丢失有限字段则会错误保存未授予的无害备注。
  it.each(['actions', 'fields'] as const)(
    'composes persisted source-role %s for the authenticated owner',
    async (boundary) => {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      // The plugin starts refreshes without returning them; await the real startup work before seeding SQLite.
      // 插件启动刷新未返回 Promise；仅观察并等待真实初始化完成，再顺序准备 SQLite 夹具。
      const pending = new Set<Promise<void>>();
      let startupResolve: () => void;
      let startupReject: (error: unknown) => void;
      const startup = new Promise<void>((resolve, reject) => {
        startupResolve = resolve;
        startupReject = reject;
      });
      const commit = Transaction.prototype.commit;
      vi.spyOn(Transaction.prototype, 'commit').mockImplementation(function (...args) {
        const work = commit.apply(this, args);
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        return work;
      });
      const refresh = MergeRoleModel.prototype.refreshDataSourcesAcl;
      vi.spyOn(MergeRoleModel.prototype, 'refreshDataSourcesAcl').mockImplementation(function (options) {
        const work = refresh.call(this, options);
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        if (!options.transaction) void work.then(startupResolve, startupReject);
        return work;
      });
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            PluginSubAccountsServer,
            { name: 'sub-accounts', packageName: '@tachybase/plugin-sub-accounts', workspaceSource: true },
          ],
        ],
      });
      await startup;
      while (pending.size) await Promise.all(pending);
      vi.restoreAllMocks();
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      const authorRole = 'merged-task-author';
      const editorRole = 'merged-task-editor';
      for (const name of [authorRole, editorRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const collectionName = 'mergedRoleTasks';
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
            { name: 'amount', type: 'integer' },
            { name: 'memo', type: 'string' },
          ],
        },
      });
      for (const roleName of [authorRole, editorRole]) {
        const writeActions =
          boundary === 'actions' ? [roleName === authorRole ? 'create' : 'update'] : ['create', 'update'];
        const writeFields = boundary === 'fields' ? [roleName === authorRole ? 'name' : 'amount'] : ['name', 'amount'];
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName,
            name: collectionName,
            usingActionsConfig: true,
            actions: [
              { name: 'list', fields: ['id', 'name', 'amount', 'memo', 'tenantId'] },
              ...writeActions.map((name) => ({ name, fields: writeFields })),
            ],
          },
        });
        const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        expect(actions.map((action) => action.get('name')).sort()).toEqual([...writeActions, 'list'].sort());
        for (const action of actions)
          expect([...action.get('fields')].sort()).toEqual(
            action.get('name') === 'list' ? ['amount', 'id', 'memo', 'name', 'tenantId'] : [...writeFields].sort(),
          );
      }
      const password = 'merged-role-test-password';
      const user = await app.db.getRepository('users').create({
        values: {
          username: 'merged-writer',
          password,
          roles: [authorRole, editorRole],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const userId = user.get('id');
      const directRoles = await app.db.getRepository('users.roles', userId).find({});
      expect(directRoles.map((role) => role.get('name')).sort()).toEqual([authorRole, editorRole]);
      const selfRole = await app.db.getRepository('users.selfRole', userId).findOne({});
      expect(selfRole.get('ownerUserId')).toBe(userId);
      const mergedRole = selfRole.get('name');
      expect(mergedRole).toBe(`m_${userId}`);
      expect(selfRole.get('snippets')).toEqual([]);

      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      const config = configFor(ownerCondition);
      await registry.store.save(
        identity,
        {
          ...config,
          revision: 0,
          rules: [authorRole, editorRole, mergedRole].map((roleName) => ({
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
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: 'merged-writer', password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user.id).toBe(userId);
      expect(signedIn.body.data.user.hasPassword).toBe(true);
      expect(signedIn.body.data.token).toEqual(expect.any(String));
      const agent = (roleName?: string) => {
        const request = app
          .agent()
          .set('Authorization', `Bearer ${signedIn.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Tenant-Id', 'B');
        return roleName ? request.set('X-Role', roleName) : request;
      };
      for (const roleName of [undefined, authorRole, editorRole]) {
        const checked = await agent(roleName).get('/auth:check');
        expect(checked.status).toBe(200);
        expect(checked.body.data.id).toBe(userId);
      }
      const tasks = app.db.getCollection(collectionName);
      const rows = () => tasks.model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const created = await agent()
        .resource(collectionName)
        .create({
          values: { name: 'Merged task', amount: 10, ...(boundary === 'fields' ? { memo: 'Unselected memo' } : {}) },
        });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Merged task', amount: 10, memo: null, tenantId: 'B' }]);
      const edited = await agent()
        .resource(collectionName)
        .update({
          filterByTk: 1,
          values: { name: 'Merged edit', amount: 20, ...(boundary === 'fields' ? { memo: 'Still unselected' } : {}) },
        });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Merged edit', amount: 20, memo: null, tenantId: 'B' }]);
      if (boundary === 'actions') {
        const deniedCreate = await agent(editorRole)
          .resource(collectionName)
          .create({ values: { name: 'Not created' } });
        expect(deniedCreate.status).toBe(403);
        const deniedUpdate = await agent(authorRole)
          .resource(collectionName)
          .update({
            filterByTk: 1,
            values: { name: 'Not edited', amount: 30 },
          });
        expect(deniedUpdate.status).toBe(403);
        expect(await rows()).toEqual([{ id: 1, name: 'Merged edit', amount: 20, memo: null, tenantId: 'B' }]);
      } else {
        const authorEdit = await agent(authorRole)
          .resource(collectionName)
          .update({
            filterByTk: 1,
            values: { name: 'Author edit', amount: 30, memo: 'Unselected author memo' },
          });
        expect(authorEdit.status).toBe(200);
        expect(authorEdit.body.data).toEqual({ keys: [1], affected: 1 });
        expect(await rows()).toEqual([{ id: 1, name: 'Author edit', amount: 20, memo: null, tenantId: 'B' }]);
        const editorEdit = await agent(editorRole)
          .resource(collectionName)
          .update({
            filterByTk: 1,
            values: { name: 'Not selected', amount: 30, memo: 'Unselected editor memo' },
          });
        expect(editorEdit.status).toBe(200);
        expect(editorEdit.body.data).toEqual({ keys: [1], affected: 1 });
        expect(await rows()).toEqual([{ id: 1, name: 'Author edit', amount: 30, memo: null, tenantId: 'B' }]);
      }
      // The original token and memberships still select the persisted merged role by default.
      // 原令牌和成员关系不变，省略角色头时仍由原插件选择持久的合并角色。
      const final = await agent()
        .resource(collectionName)
        .update({
          filterByTk: 1,
          values: { name: 'Final merged edit', amount: 40 },
        });
      expect(final.status).toBe(200);
      expect(final.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Final merged edit', amount: 40, memo: null, tenantId: 'B' }]);
      const visible = await agent()
        .resource(collectionName)
        .list({
          fields: ['id', 'name', 'amount', 'memo', 'tenantId'],
          sort: ['id'],
        });
      expect(visible.status).toBe(200);
      expect(visible.body.data).toEqual([{ id: 1, name: 'Final merged edit', amount: 40, memo: null, tenantId: 'B' }]);
    },
  );
});
