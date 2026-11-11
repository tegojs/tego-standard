import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated record template duplication', () => {
  // Native template reads remove the source key; create still needs its own permission.
  // 原生模板读取移除来源主键，新增仍须独立操作权限。
  it('duplicates selected scalar fields through native template reads and a separately authorized create', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      const collectionName = 'templateBusinessTasks';
      const editor = 'template-editor';
      const reader = 'template-reader';
      const denied = 'template-without-actions';
      for (const name of [editor, reader, denied])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      const password = 'template-user-password';
      const user = await app.db.getRepository('users').create({
        values: {
          username: editor,
          password,
          roles: [editor, reader, denied],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
            { name: 'name', type: 'string' },
            { name: 'amount', type: 'integer' },
            { name: 'privateNote', type: 'string' },
          ],
        },
      });
      for (const roleName of [editor, reader]) {
        const actions = [
          { name: 'get', fields: ['id', 'name', 'amount'] },
          { name: 'list', fields: ['id', 'name', 'amount', 'tenantId', 'privateNote'] },
          ...(roleName === editor ? [{ name: 'create', fields: ['name', 'amount', 'privateNote'] }] : []),
        ];
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: { dataSourceKey: 'main', roleName, name: collectionName, usingActionsConfig: true, actions },
        });
        expect(
          (await resource.getActions())
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(
          actions
            .map((action) => ({ name: action.name, fields: [...action.fields].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
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
            ],
          }),
          revision: 0,
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      let selected = true;
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
      );
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: editor, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = (role = editor) =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const source = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Task to duplicate', amount: 120, privateNote: 'Source fixture note' } });
      expect(source.status).toBe(200);
      expect(source.body.data).toEqual({ keys: [1], affected: 1 });
      const initial = [
        { id: 1, name: 'Task to duplicate', amount: 120, privateNote: 'Source fixture note', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(initial);
      const detail = await agent()
        .resource(collectionName)
        .get({ filterByTk: 1, fields: ['id', 'name', 'amount'] });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual({ id: 1, name: 'Task to duplicate', amount: 120 });
      const template = (role = editor) =>
        agent(role)
          .resource(collectionName)
          .get({ filterByTk: 1, fields: ['id', 'name', 'amount'], isTemplate: true });
      selected = false;
      const legacy = await template();
      expect(legacy.status).toBe(200);
      expect(legacy.body.data).toEqual({ name: 'Task to duplicate', amount: 120 });
      expect(await rows()).toEqual(initial);
      selected = true;
      const current = await template();
      expect(current.status).toBe(200);
      expect(current.body.data).toEqual({ name: 'Task to duplicate', amount: 120 });
      const blockedRead = await template(denied);
      expect(blockedRead.status).toBe(403);
      const readable = await template(reader);
      expect(readable.status).toBe(200);
      expect(readable.body.data).toEqual({ name: 'Task to duplicate', amount: 120 });
      const blockedCreate = await agent(reader).resource(collectionName).create({ values: readable.body.data });
      expect(blockedCreate.status).toBe(403);
      expect(await rows()).toEqual(initial);
      const copy = await agent().resource(collectionName).create({ values: current.body.data });
      expect(copy.status).toBe(200);
      expect(copy.body.data).toEqual({ keys: [2], affected: 1 });
      const final = [...initial, { id: 2, name: 'Task to duplicate', amount: 120, privateNote: null, tenantId: 'B' }];
      expect(await rows()).toEqual(final);
      const list = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(final);
      for (const params of [
        { filterByTk: 1, isTemplate: true },
        { filterByTk: 1, fields: [], isTemplate: true },
        { filterByTk: 1, fields: ['name'], isTemplate: 'unsupported' },
      ]) {
        const invalid = await agent().resource(collectionName).get(params);
        expect(invalid.status).toBe(400);
      }
      const invalidList = await agent()
        .resource(collectionName)
        .list({ fields: ['name'], isTemplate: true });
      expect(invalidList.status).toBe(400);
      expect(await rows()).toEqual(final);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
