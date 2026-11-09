import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated native user audit fields on root writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Losing the real request context or treating audit FKs as ordinary fields must break these outcomes.
  // 丢失真实请求上下文或把审计外键视为普通字段，必须破坏这些持久结果。
  it.each(['createdById', 'updatedById'] as const)(
    'retains the creator and records the authenticated editor while rejecting client %s',
    async (auditField) => {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      const role = 'audited-task-editor';
      const password = 'audit-field-test-password';
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const accounts = ['audit-task-author', 'audit-task-editor'];
      const userIds: number[] = [];
      for (const username of accounts) {
        const user = await app.db.getRepository('users').create({
          values: { username, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
        });
        userIds.push(user.get('id') as number);
      }
      const [authorId, editorId] = userIds;
      expect(authorId).toEqual(expect.any(Number));
      expect(editorId).toEqual(expect.any(Number));
      expect(editorId).not.toBe(authorId);
      const collectionName = 'auditedTasks';
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: true,
          updatedBy: true,
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      const fields = ['id', 'name', 'tenantId', 'createdById', 'updatedById'];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields },
            { name: 'create', fields: ['name'] },
            { name: 'update', fields: ['name'] },
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['createdById', 'id', 'name', 'tenantId', 'updatedById'] },
        { name: 'update', fields: ['name'] },
      ]);
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      const config = configFor(ownerCondition);
      await registry.store.save(
        identity,
        {
          ...config,
          revision: 0,
          rules: [authorId, editorId].map((userId) => ({
            ...config.rules[0],
            id: `audited-user-${userId}`,
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
          })),
        },
        { userId: authorId },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [identity.collectionKey]),
      );
      const tokens: string[] = [];
      for (const [index, account] of accounts.entries()) {
        const signedIn = await app
          .agent()
          .post('/auth:signIn')
          .set('X-Authenticator', 'basic')
          .send({ account, password });
        expect(signedIn.status).toBe(200);
        expect(signedIn.body.data.user.id).toBe(userIds[index]);
        expect(signedIn.body.data.user.hasPassword).toBe(true);
        expect(signedIn.body.data.token).toEqual(expect.any(String));
        tokens.push(signedIn.body.data.token);
      }
      const agent = (index: number) =>
        app
          .agent()
          .set('Authorization', `Bearer ${tokens[index]}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      for (const index of [0, 1]) {
        const checked = await agent(index).get('/auth:check');
        expect(checked.status).toBe(200);
        expect(checked.body.data.id).toBe(userIds[index]);
      }
      const collection = app.db.getCollection(collectionName);
      const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const created = await agent(0)
        .resource(collectionName)
        .create({ values: { name: 'Author task' } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      const original = [{ id: 1, name: 'Author task', tenantId: 'B', createdById: authorId, updatedById: authorId }];
      expect(await rows()).toEqual(original);
      const visible = await agent(1)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(visible.status).toBe(200);
      expect(visible.body.data).toEqual(original);
      // Both IDs are known fixture users; no hidden or external identity is queried.
      // 两个 ID 均为已知夹具用户，不查询隐藏或外部身份。
      const suppliedAudit = { name: 'Client audit input', [auditField]: authorId };
      const rejectedCreate = await agent(1).resource(collectionName).create({ values: suppliedAudit });
      expect(rejectedCreate.status).toBe(400);
      expect(rejectedCreate.body.errors[0].message).toContain('protected keys');
      expect(await rows()).toEqual(original);
      const rejectedUpdate = await agent(1).resource(collectionName).update({ filterByTk: 1, values: suppliedAudit });
      expect(rejectedUpdate.status).toBe(400);
      expect(rejectedUpdate.body.errors[0].message).toContain('protected keys');
      expect(await rows()).toEqual(original);
      const edited = await agent(1)
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Editor task' } });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([
        { id: 1, name: 'Editor task', tenantId: 'B', createdById: authorId, updatedById: editorId },
      ]);
      const returned = await agent(0)
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Author final task' } });
      expect(returned.status).toBe(200);
      expect(returned.body.data).toEqual({ keys: [1], affected: 1 });
      const final = [{ id: 1, name: 'Author final task', tenantId: 'B', createdById: authorId, updatedById: authorId }];
      expect(await rows()).toEqual(final);
      const finalList = await agent(1)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(finalList.status).toBe(200);
      expect(finalList.body.data).toEqual(final);
    },
  );
});
