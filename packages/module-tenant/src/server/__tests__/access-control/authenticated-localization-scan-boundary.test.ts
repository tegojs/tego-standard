import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import LocalizationManagementPlugin from '../../../../../plugin-i18n-editor/src/server';
import type { LocalizationDatabaseTextReadRequest } from '../../../../../plugin-i18n-editor/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { assertLegacyReadBoundary } from '../../access-control/legacy-read-boundary';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated localization business scan boundary', () => {
  it.each([true, false])('preserves explicit database text extraction boundaries (guarded: %s)', async (guarded) => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let identity: AccessCollectionIdentity;
    let mode: 'normal' | 'async' | 'invalid' | 'throw' = 'normal';
    const observed: LocalizationDatabaseTextReadRequest[] = [];
    const selectedKeys = new Set<string>();
    const role = 'business-localization-operator';
    const reader = 'business-localization-reader';
    const password = 'localization-scan-boundary-password';
    const collectionName = 'localizationEmptyBusinessLabels';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            LocalizationManagementPlugin,
            {
              name: 'localization-management',
              packageName: '@tachybase/plugin-i18n-editor',
              workspaceSource: true,
              databaseTextReadGuard: guarded
                ? (request) => {
                    if (request.collectionName === collectionName) {
                      observed.push(request);
                      if (mode === 'async') return Promise.resolve() as never;
                      if (mode === 'invalid') return false as never;
                      if (mode === 'throw') throw new Error('Test localization scan refused');
                    }
                    return assertLegacyReadBoundary(
                      app.db,
                      request.collection,
                      request.params,
                      (target) => selectedKeys.has(target.options.key),
                      request.context,
                    );
                  }
                : undefined,
            },
          ],
        ],
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [role, reader])
        await app.db.getRepository('roles').create({
          values: {
            name,
            strategy: { actions: [] },
            snippets: name === role ? ['pm.localization-management.localization'] : [],
          },
        });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role, reader], tenants: ['B'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string', translation: true }],
        },
      });
      const collection = app.db.getCollection(collectionName);
      expect(collection.getField('name').options.translation).toBe(true);
      for (const roleName of [role, reader]) {
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName,
            name: collectionName,
            usingActionsConfig: true,
            actions: [{ name: 'list', fields: ['id', 'name', 'tenantId'] }],
          },
        });
        const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        expect(actions.map((action) => action.get('name'))).toEqual(['list']);
        expect([...actions[0].get('fields')].sort()).toEqual(['id', 'name', 'tenantId']);
      }
      identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      await registry.store.save(
        identity,
        { ...configFor(ownerCondition), revision: 0, rules: [] },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selectedKeys]));
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user.id).toBe(user.id);
      expect(signedIn.body.data.user.hasPassword).toBe(true);
      expect(signedIn.body.data.token).toEqual(expect.any(String));
      const agent = (roleName = role) =>
        app
          .agent()
          .set('Authorization', `Bearer ${signedIn.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const rows = () => collection.model.findAll({ raw: true });
      const catalog = () => app.db.getModel('localizationTexts').findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      let businessReads = 0;
      let failRead = false;
      collection.model.addHook('beforeFind', 'observeLocalizationScan', () => {
        businessReads++;
        if (failRead) throw new Error('Test localization business read failed');
      });
      const request = (roleName = role) =>
        agent(roleName)
          .resource('localization')
          .sync({ values: { type: ['db'] } });
      const forbidden = await request(reader);
      expect(forbidden.status).toBe(403);
      expect(businessReads).toBe(0);
      const ordinary = await request();
      expect(ordinary.status).toBe(200);
      expect(businessReads).toBe(1);
      const before = await catalog();
      if (guarded) {
        const captured = observed.at(-1)!;
        expect(Object.isFrozen(captured)).toBe(true);
        expect(Object.isFrozen(captured.params)).toBe(true);
        expect(captured.collection).toBe(collection);
        expect(captured.params).toEqual({ fields: ['name'] });
        expect(captured.context).toMatchObject({
          state: { currentUser: { id: user.id }, currentRole: role, currentTenantId: 'B' },
        });
      } else expect(observed).toEqual([]);
      const plugin = app.pm.get(LocalizationManagementPlugin) as LocalizationManagementPlugin;
      plugin.options.databaseTextReadGuard = false as never;
      expect(() => plugin.beforeLoad()).toThrow(/guard must be a function/);
      plugin.options.databaseTextReadGuard = () => {
        throw new Error('Loaded options must not replace the captured callback');
      };
      selectedKeys.add(identity.collectionKey);
      const direct = await agent().resource(collectionName).list();
      expect(direct.status).toBe(200);
      expect(direct.body.data).toEqual([]);
      businessReads = 0;
      const denied = await request();
      expect({ status: denied.status, businessReads, catalog: await catalog() }).toEqual({
        status: guarded ? 400 : 200,
        businessReads: guarded ? 0 : 1,
        catalog: before,
      });
      if (guarded) {
        expect(denied.body.errors[0].message).toMatch(/Legacy reads of selected access collections/);
        for (const value of ['async', 'invalid', 'throw'] as const) {
          mode = value;
          businessReads = 0;
          const failed = await request();
          expect({ status: failed.status, businessReads, catalog: await catalog() }).toEqual({
            status: 500,
            businessReads: 0,
            catalog: before,
          });
        }
      }
      mode = 'normal';
      selectedKeys.clear();
      businessReads = 0;
      expect((await request()).status).toBe(200);
      expect(businessReads).toBe(1);
      failRead = true;
      businessReads = 0;
      const failed = await request();
      expect({ status: failed.status, businessReads, catalog: await catalog() }).toEqual({
        status: 500,
        businessReads: 1,
        catalog: before,
      });
      collection.model.removeHook('beforeFind', 'observeLocalizationScan');
      expect(await rows()).toEqual([]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
