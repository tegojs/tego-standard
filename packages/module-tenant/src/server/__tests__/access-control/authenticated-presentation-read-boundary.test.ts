import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import PresentationPlugin from '../../../../../plugin-block-presentation/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated presentation HTML read boundary', () => {
  // Falling through to the original custom action would expose a selected row outside G/V.
  // 自定义动作落回原处理器会绕过选中记录的G/V边界。
  it('refuses the unadapted raw HTML action before its repository read and preserves unselected behavior', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const role = 'presentation-reader';
    const password = 'presentation-reader-password';
    const html = '<p>Known harmless presentation</p>';
    const selectedKeys = new Set<string>();
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            PresentationPlugin,
            { name: 'block-presentation', packageName: '@tachybase/plugin-block-presentation', workspaceSource: true },
          ],
        ],
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: 'iframeHtml',
          tenancy: 'shared',
          timestamps: true,
          createdBy: true,
          updatedBy: true,
          fields: [
            { name: 'id', type: 'uid', primaryKey: true },
            { name: 'html', type: 'text' },
          ],
        },
      });
      const collection = app.db.getCollection('iframeHtml');
      expect(collection.options.tenancy).toBe('shared');
      expect(collection.hasField('tenantId')).toBe(false);
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: 'iframeHtml',
          usingActionsConfig: true,
          actions: [
            { name: 'create', fields: ['html'] },
            { name: 'list', fields: ['id', 'html'] },
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['html'] },
        { name: 'list', fields: ['html', 'id'] },
      ]);
      const source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: 'iframeHtml' };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      await registry.store.save(
        source,
        {
          ...configFor({
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
                operator: 'ne',
                left: { type: 'field', path: 'html' },
                right: { type: 'literal', value: html },
              },
            ],
          }),
          ownership: { enabled: false },
          revision: 0,
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = () =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-ID', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const rows = () => collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const created = await agent().resource('iframeHtml').create({ values: { html } });
      expect(created.status).toBe(200);
      const id = created.body.data.id;
      expect(id).toEqual(expect.any(String));
      const expected = await rows();
      expect(expected).toEqual([
        {
          id,
          html,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          createdById: user.id,
          updatedById: user.id,
        },
      ]);
      expect(Number.isFinite(Date.parse(expected[0].createdAt))).toBe(true);
      expect(expected[0].updatedAt).toBe(expected[0].createdAt);
      const readHtml = () => agent().get('/iframeHtml:getHtml').query({ filterByTk: id });
      const baseline = await readHtml();
      expect(baseline.status).toBe(200);
      expect(baseline.headers['content-type']).toMatch(/^text\/html/);
      expect(baseline.text).toBe(html);
      selectedKeys.add(source.collectionKey);
      const list = await agent().resource('iframeHtml').list({});
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([]);
      let rawReads = 0;
      collection.model.addHook('beforeFind', 'presentation-read-observer', () => {
        rawReads++;
      });
      const refused = await readHtml();
      expect(refused.status).toBe(400);
      expect(refused.body.data).toBeUndefined();
      expect(refused.text).not.toContain(html);
      expect(rawReads).toBe(0);
      collection.model.removeHook('beforeFind', 'presentation-read-observer');
      expect(await rows()).toEqual(expected);
      selectedKeys.clear();
      const legacy = await readHtml();
      expect(legacy.status).toBe(200);
      expect(legacy.text).toBe(html);
      expect(await rows()).toEqual(expected);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
