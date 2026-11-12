import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business action metadata', () => {
  // Metadata must not advertise writes from visibility alone or substitute list permission for write ACL.
  // 可见性不能产生可写提示，列表权限也不能代替写动作权限。
  it('reports writable keys separately from visible keys after a normal business submission', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const editor = 'action-meta-editor';
    const reader = 'action-meta-reader';
    const scopedEditor = 'action-meta-scoped-editor';
    const collectionName = 'actionMetaTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [editor, reader, scopedEditor])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'action-meta-password';
      const user = await app.db.getRepository('users').create({
        values: {
          username: editor,
          password,
          roles: [editor, reader, scopedEditor],
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
            { name: 'name', type: 'string' },
            { name: 'stage', type: 'string' },
          ],
        },
      });
      const actionScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          key: 'submitted-only',
          dataSourceKey: 'main',
          resourceName: collectionName,
          scope: { id: { $eq: 1 } },
        },
      });
      expect(actionScope.get('scope')).toEqual({ id: { $eq: 1 } });
      for (const roleName of [editor, reader, scopedEditor]) {
        const expected = [
          { name: 'view', fields: ['id', 'name', 'stage', 'tenantId'], scopeId: null },
          ...(roleName !== reader
            ? [
                { name: 'create', fields: ['name', 'stage'], scopeId: null },
                {
                  name: 'update',
                  fields: ['name', 'stage'],
                  scopeId: roleName === scopedEditor ? actionScope.id : null,
                },
                { name: 'destroy', fields: [], scopeId: roleName === scopedEditor ? actionScope.id : null },
              ]
            : []),
        ].sort((a, b) => a.name.localeCompare(b.name));
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName,
            name: collectionName,
            usingActionsConfig: true,
            actions: expected,
          },
        });
        expect(
          (await resource.getActions())
            .map((action) => ({
              name: action.get('name'),
              fields: [...(action.get('fields') || [])].sort(),
              scopeId: action.get('scopeId') ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(expected);
      }
      const registry = new AccessMainRootResourceRegistry(app);
      const source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const config = configFor({
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
            left: { type: 'field', path: 'stage' },
            right: { type: 'literal', value: 'draft' },
          },
        ],
      });
      config.rules.push({ ...configFor(ownerCondition, 'visibility').rules[0], id: 'visible' });
      await registry.store.save(source, { ...config, revision: 0 }, { userId: user.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [source.collectionKey]),
      );
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: editor, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const agent = (role = editor) =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      for (const name of ['First draft', 'Second draft']) {
        const created = await agent()
          .resource(collectionName)
          .create({ values: { name, stage: 'draft' } });
        expect(created.status).toBe(200);
      }
      const submitted = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Submitted task', stage: 'submitted' } });
      expect(submitted.status).toBe(200);
      expect(submitted.body.data).toEqual({ keys: [1], affected: 1 });
      const expectedRows = [
        { id: 1, name: 'Submitted task', stage: 'submitted', tenantId: 'B' },
        { id: 2, name: 'Second draft', stage: 'draft', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expectedRows);
      const denied = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Rejected edit' } });
      expect(denied.status).toBe(403);
      expect(await rows()).toEqual(expectedRows);
      const listed = await agent()
        .set('X-With-ACL-Meta', 'true')
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expectedRows);
      expect(listed.body.meta.allowedActions).toEqual({ view: [1, 2], update: [2], destroy: [2] });
      const detail = await agent().set('X-With-ACL-Meta', 'true').resource(collectionName).get({ filterByTk: 1 });
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(expectedRows[0]);
      expect(detail.body.meta.allowedActions).toEqual({ view: [1], update: [], destroy: [] });
      const page = await agent()
        .set('X-With-ACL-Meta', 'true')
        .resource(collectionName)
        .list({ sort: ['id'], page: 2, pageSize: 1 });
      expect(page.status).toBe(200);
      expect(page.body.data).toEqual([expectedRows[1]]);
      expect(page.body.meta.allowedActions).toEqual({ view: [2], update: [2], destroy: [2] });
      const scoped = await agent(scopedEditor)
        .set('X-With-ACL-Meta', 'true')
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(scoped.status).toBe(200);
      expect(scoped.body.data).toEqual(expectedRows);
      expect(scoped.body.meta.allowedActions).toEqual({ view: [1, 2], update: [], destroy: [] });
      const scopedDenied = await agent(scopedEditor)
        .resource(collectionName)
        .update({ filterByTk: 2, values: { name: 'Outside action ACL' } });
      expect(scopedDenied.status).toBe(403);
      expect(await rows()).toEqual(expectedRows);
      const readOnly = await agent(reader)
        .set('X-With-ACL-Meta', 'true')
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(readOnly.status).toBe(200);
      expect(readOnly.body.data).toEqual(expectedRows);
      expect(readOnly.body.meta.allowedActions).toEqual({ view: [1, 2], update: [], destroy: [] });
      const edited = await agent()
        .resource(collectionName)
        .update({ filterByTk: 2, values: { name: 'Edited draft' } });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toEqual({ keys: [2], affected: 1 });
      expect(await rows()).toEqual([expectedRows[0], { ...expectedRows[1], name: 'Edited draft' }]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
