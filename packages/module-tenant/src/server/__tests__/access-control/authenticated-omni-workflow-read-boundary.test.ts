import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin from '../../../../../module-workflow/src/server';
import {
  OmniTrigger,
  type WorkflowOmniReadRequest,
} from '../../../../../module-workflow/src/server/features/omni-trigger/CustomActionTrigger';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { AccessMainWorkflowCollectionReadBoundary } from '../../access-control/main-workflow-collection-read-boundary';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated omni workflow resource business reload', () => {
  it.each([true, false])('preserves the explicit business reload boundary (guarded: %s)', async (guarded) => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let boundary: AccessMainWorkflowCollectionReadBoundary;
    let identity: AccessCollectionIdentity;
    let mode: 'normal' | 'async' | 'invalid' | 'throw' = 'normal';
    const observed: WorkflowOmniReadRequest[] = [];
    const selectedKeys = new Set<string>();
    const role = 'omni-reload-business-member';
    const password = 'omni-reload-boundary-password';
    const collectionName = 'omniReloadEmptyTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            'workflow',
            {
              omniWorkflowReadGuard: guarded
                ? (request) => {
                    observed.push(request);
                    if (mode === 'async') return Promise.resolve() as never;
                    if (mode === 'invalid') return false as never;
                    if (mode === 'throw') throw new Error('Test omni business reload refused');
                    return boundary.assert(request, selectedKeys.has(identity.collectionKey) ? [identity] : []);
                  }
                : undefined,
            },
          ],
        ],
      });
      boundary = new AccessMainWorkflowCollectionReadBoundary(app);
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: 'omniReloadEmptyDetails',
          tenancy: 'shared',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string' }],
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
            { name: 'detail', type: 'belongsTo', target: 'omniReloadEmptyDetails', foreignKey: 'detailId' },
          ],
        },
      });
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'name', 'tenantId'] }],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(actions.map((action) => action.get('name'))).toEqual(['list']);
      expect([...actions[0].get('fields')].sort()).toEqual(['id', 'name', 'tenantId']);
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
      const plugin = app.pm.get('workflow') as WorkflowPlugin;
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Empty business reload before workflow action',
          type: 'general-action',
          enabled: true,
          sync: true,
          config: { collection: collectionName, appends: ['detail'] },
        },
      });
      await workflow.createNode({ type: 'end', config: {} });
      expect(plugin.enabledCache.get(workflow.id)?.key).toBe(workflow.key);
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user.id).toBe(user.id);
      expect(signedIn.body.data.user.hasPassword).toBe(true);
      expect(signedIn.body.data.token).toEqual(expect.any(String));
      const agent = () =>
        app
          .agent()
          .set('Authorization', `Bearer ${signedIn.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const collection = app.db.getCollection(collectionName);
      const rows = () => collection.model.findAll({ raw: true });
      expect(await rows()).toEqual([]);
      let businessReads = 0;
      collection.model.addHook('beforeFind', 'observeOmniBusinessReload', () => businessReads++);
      const request = () =>
        agent()
          .resource('workflows')
          .trigger({ values: { id: 1 }, beforeWorkflows: workflow.key, triggerWorkflows: workflow.key });
      const ordinary = await request();
      expect(ordinary.status).toBe(200);
      expect(businessReads).toBe(1);
      expect(await workflow.countExecutions()).toBe(0);
      if (guarded) {
        const captured = observed.at(-1)!;
        expect(Object.isFrozen(captured)).toBe(true);
        expect(captured.dataSourceName).toBe('main');
        expect(captured.collectionName).toBe(collectionName);
        expect(captured.collection).toBe(collection);
        expect(captured.params).toEqual({ filterByTk: 1, appends: ['detail'], filter: { tenantId: 'B' } });
        expect(captured.context).toMatchObject({
          state: { currentUser: { id: user.id }, currentRole: role, currentTenantId: 'B' },
        });
        expect(() => plugin.captureDataOperationAuthority(captured)).toThrow(/authority is unavailable/);
      } else expect(observed).toEqual([]);
      plugin.options.omniWorkflowReadGuard = false as never;
      expect(() => new OmniTrigger(plugin)).toThrow(/guard must be a function/);
      plugin.options.omniWorkflowReadGuard = () => {
        throw new Error('Loaded options must not replace the captured callback');
      };
      selectedKeys.add(identity.collectionKey);
      const direct = await agent().resource(collectionName).list();
      expect(direct.status).toBe(200);
      expect(direct.body.data).toEqual([]);
      businessReads = 0;
      const denied = await request();
      expect({ status: denied.status, businessReads, executions: await workflow.countExecutions() }).toEqual({
        status: guarded ? 400 : 200,
        businessReads: guarded ? 0 : 1,
        executions: 0,
      });
      if (guarded) {
        expect(denied.body.errors[0].message).toMatch(/Legacy reads of selected access collections/);
        for (const value of ['async', 'invalid', 'throw'] as const) {
          mode = value;
          businessReads = 0;
          const failed = await request();
          expect({ status: failed.status, businessReads, executions: await workflow.countExecutions() }).toEqual({
            status: 500,
            businessReads: 0,
            executions: 0,
          });
        }
      }
      mode = 'normal';
      selectedKeys.clear();
      businessReads = 0;
      expect((await request()).status).toBe(200);
      expect(businessReads).toBe(1);
      expect(await workflow.countExecutions()).toBe(0);
      collection.model.removeHook('beforeFind', 'observeOmniBusinessReload');
      expect(await rows()).toEqual([]);
      expect(await app.db.getCollection('omniReloadEmptyDetails').model.findAll({ raw: true })).toEqual([]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
