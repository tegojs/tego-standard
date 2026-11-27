import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin, { EXECUTION_STATUS } from '../../../../../module-workflow/src/server';
import type { WorkflowOmniReadRequest } from '../../../../../module-workflow/src/server/features/omni-trigger/CustomActionTrigger';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { AccessMainWorkflowCollectionReadBoundary } from '../../access-control/main-workflow-collection-read-boundary';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated omni after-create association reload', () => {
  // An after-action workflow must refuse an unadapted selected association before reloading it.
  // 后置工作流必须在重读前拒绝未适配的选中关联，不声称回滚已完成的新增。
  it.each([true, false])('checks the reload before publishing an execution (guarded: %s)', async (guarded) => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let boundary: AccessMainWorkflowCollectionReadBoundary;
    let identity: AccessCollectionIdentity;
    let mode: 'normal' | 'async' | 'invalid' | 'throw' = 'normal';
    const observed: WorkflowOmniReadRequest[] = [];
    const selected = new Set<string>();
    const sourceName = 'omniAfterTasks';
    const targetName = 'omniAfterEmptyDetails';
    const role = 'omni-after-member';
    const password = 'omni-after-password';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            WorkflowPlugin,
            {
              name: 'workflow',
              packageName: '@tachybase/module-workflow',
              workspaceSource: true,
              omniWorkflowReadGuard: guarded
                ? (request) => {
                    observed.push(request);
                    if (mode === 'async') return Promise.resolve() as never;
                    if (mode === 'invalid') return false as never;
                    if (mode === 'throw') throw new Error('Test after-action reload refused');
                    return boundary.assert(request, selected.has(identity.collectionKey) ? [identity] : []);
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
      const target = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: targetName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: sourceName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'detail', type: 'belongsTo', target: targetName, foreignKey: 'detailId' },
          ],
        },
      });
      for (const [name, actions] of [
        [
          sourceName,
          [
            { name: 'create', fields: ['name'] },
            { name: 'list', fields: ['id', 'name', 'detailId', 'tenantId'] },
          ],
        ],
        [targetName, [{ name: 'list', fields: ['id', 'name', 'tenantId'] }]],
      ] as const) {
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName: role,
            name,
            usingActionsConfig: true,
            actions,
          },
        });
        const stored = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        expect(
          stored
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(
          actions
            .map((action) => ({ name: action.name, fields: [...action.fields].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
      identity = { dataSourceKey: 'main', collectionKey: target.get('key'), collectionName: targetName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      await registry.store.save(
        identity,
        { ...configFor(ownerCondition), revision: 0, rules: [] },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => registry.select(ctx, adapter, [...selected]));
      const plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Harmless after-create reload',
          type: 'general-action',
          enabled: true,
          sync: true,
          config: { collection: sourceName, appends: ['detail'] },
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
      expect(signedIn.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
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
      const source = app.db.getCollection(sourceName);
      const details = app.db.getCollection(targetName);
      const rows = () => source.model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      expect(await details.model.findAll({ raw: true })).toEqual([]);
      let reloads = 0;
      source.model.addHook('beforeFind', 'observeAfterActionReload', () => reloads++);
      const request = (name: string) =>
        agent().resource(sourceName).create({ values: { name }, triggerWorkflows: workflow.key });
      const baseline = await request('Baseline');
      expect(baseline.status).toBe(200);
      expect(reloads).toBe(1);
      const baselineExecutions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(baselineExecutions).toHaveLength(1);
      expect(baselineExecutions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(baselineExecutions[0].context.data).toEqual({
        id: 1,
        name: 'Baseline',
        detailId: null,
        tenantId: 'B',
        detail: null,
      });
      selected.add(identity.collectionKey);
      const direct = await agent().resource(targetName).list();
      expect(direct.status).toBe(200);
      expect(direct.body.data).toEqual([]);
      reloads = 0;
      const denied = await request('Selected association');
      expect({ status: denied.status, reloads, executions: await workflow.countExecutions() }).toEqual({
        status: guarded ? 400 : 200,
        reloads: guarded ? 0 : 1,
        executions: guarded ? 1 : 2,
      });
      expect(await rows()).toEqual([
        { id: 1, name: 'Baseline', detailId: null, tenantId: 'B' },
        { id: 2, name: 'Selected association', detailId: null, tenantId: 'B' },
      ]);
      if (guarded) {
        expect(denied.body.errors[0].message).toMatch(/Legacy reads of selected access collections/);
        const captured = observed.at(-1)!;
        expect(Object.isFrozen(captured)).toBe(true);
        expect(captured).toMatchObject({
          dataSourceName: 'main',
          collectionName: sourceName,
          params: { filterByTk: 2, appends: ['detail'], filter: { tenantId: 'B' } },
          context: { state: { currentUser: { id: user.id }, currentRole: role, currentTenantId: 'B' } },
        });
        expect(captured.collection).toBe(source);
        expect(() => plugin.captureDataOperationAuthority(captured)).toThrow(/authority is unavailable/);
        for (const value of ['async', 'invalid', 'throw'] as const) {
          mode = value;
          reloads = 0;
          const failed = await request(value);
          expect({ status: failed.status, reloads, executions: await workflow.countExecutions() }).toEqual({
            status: 500,
            reloads: 0,
            executions: 1,
          });
        }
      } else expect(observed).toEqual([]);
      mode = 'normal';
      selected.clear();
      reloads = 0;
      const restored = await request('Restored');
      expect(restored.status).toBe(200);
      expect(reloads).toBe(1);
      expect(await workflow.countExecutions()).toBe(guarded ? 2 : 3);
      source.model.removeHook('beforeFind', 'observeAfterActionReload');
      const expected = [
        { id: 1, name: 'Baseline', detailId: null, tenantId: 'B' },
        { id: 2, name: 'Selected association', detailId: null, tenantId: 'B' },
        ...(guarded
          ? [
              { id: 3, name: 'async', detailId: null, tenantId: 'B' },
              { id: 4, name: 'invalid', detailId: null, tenantId: 'B' },
              { id: 5, name: 'throw', detailId: null, tenantId: 'B' },
            ]
          : []),
        { id: guarded ? 6 : 3, name: 'Restored', detailId: null, tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expected);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      const published = guarded ? [expected[0], expected[5]] : expected;
      expect(executions.map((execution) => execution.context.data)).toEqual(
        published.map((row) => ({ ...row, detail: null })),
      );
      for (const execution of executions) {
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.context).toMatchObject({ user: { id: user.id }, roleName: role });
      }
      const listed = await agent()
        .resource(sourceName)
        .list({ sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(expected);
      expect(await details.model.findAll({ raw: true })).toEqual([]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
