import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import webhookCategoriesCollection from '../../../../../module-event-source/src/server/collections/webhookCategories';
import webhooksCollection from '../../../../../module-event-source/src/server/collections/webhooks';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { WebhookCategories } from '../../../../../module-event-source/src/server/model/WebhookCategories';
import { DatabaseEventTrigger } from '../../../../../module-event-source/src/server/trigger/DatabaseEventTrigger';
import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowCollectionReadBoundary } from '../../access-control/main-workflow-collection-read-boundary';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated database-event raw model read boundary', () => {
  // An unsupported selected raw-model read must stop before the script or its target write.
  // 未适配的选中模型读取必须在脚本及目标业务写入之前停止。
  it('refuses a selected source before evaluating its database-event script and preserves old-source writes', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let plugin: WorkflowPlugin;
    const selected: AccessCollectionIdentity[] = [];
    const observed: object[] = [];
    const eventModels: Model[] = [];
    const eventContexts: object[] = [];
    let guardMode: 'normal' | 'async' | 'invalid' | 'throw' = 'normal';
    let sourceIdentity: AccessCollectionIdentity;
    const role = 'database-read-member';
    const password = 'database-read-password';
    const sourceName = 'databaseReadInputs';
    const targetName = 'databaseReadTasks';
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
              createResolver: (request) => {
                const authority = plugin.captureDataOperationAuthority(request);
                observed.push({ ...authority.identityContext.state });
                return runtime.resolveCreate(request, selected);
              },
              createTransactionPlanner: (target) => runtime.plan(target, selected),
            },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      app.db.registerModels({ EventSourceModel, WebhookCategories });
      app.db.collection(webhooksCollection);
      app.db.collection(webhookCategoriesCollection);
      await app.db.sync();
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      await app.db.collection(accessConfigHistory).model.sync();
      for (const collectionName of [sourceName, targetName]) {
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
            ],
          },
        });
        const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
        if (collectionName === sourceName) sourceIdentity = identity;
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName: role,
            name: collectionName,
            usingActionsConfig: true,
            actions: [
              { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
              { name: 'create', fields: ['name', 'amount'] },
            ],
          },
        });
        const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        expect(
          actions
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          { name: 'create', fields: ['amount', 'name'] },
          { name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] },
        ]);
        await runtime.registry.store.save(
          identity,
          {
            ...configFor({
              type: 'all',
              children: [
                ownerCondition,
                {
                  type: 'compare',
                  operator: 'gte',
                  left: { type: 'field', path: 'amount' },
                  right: { type: 'literal', value: collectionName === targetName ? 100 : 0 },
                },
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
              ],
            }),
            revision: 0,
          },
          { userId: user.id },
        );
      }
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        runtime.registry.select(
          ctx,
          adapter,
          selected.map((identity) => identity.collectionKey),
        ),
      );
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
        app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', role);
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const rows = (name: string) =>
        app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']], transaction: null });
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(targetName)).toEqual([]);
      const baseline = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Before listener', amount: 120 } });
      expect(baseline.status).toBe(200);
      expect(baseline.body.data).toEqual({ id: 1, name: 'Before listener', amount: 120, tenantId: 'B' });
      const baselineRows = [{ id: 1, name: 'Before listener', amount: 120, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(baselineRows);
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'databaseReadSignals', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Database event target create',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'databaseReadSignals', mode: 1 },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        config: {
          collection: targetName,
          params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
        },
      });
      const eventName = `${sourceName}.afterCreateWithAssociations`;
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Database event intake',
          type: 'database',
          enabled: true,
          workflowKey: workflow.key,
          code: "ctx.model.set('name', ctx.model.get('name') + ' evaluated'); ctx.body = ctx.model.toJSON();",
          options: { eventName },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect({ code: persisted.code, workflowKey: persisted.workflowKey, options: persisted.options }).toEqual({
        code: "ctx.model.set('name', ctx.model.get('name') + ' evaluated'); ctx.body = ctx.model.toJSON();",
        workflowKey: workflow.key,
        options: { eventName },
      });
      app.db.on(eventName, (record, options) => {
        eventModels.push(record);
        eventContexts.push(options.context);
      });
      const boundary = new AccessMainWorkflowCollectionReadBoundary(app);
      expect(() => new DatabaseEventTrigger(app, false, true as never)).toThrow(/must be a function/);
      const trigger = new DatabaseEventTrigger(app, false, (request) => {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.params)).toBe(true);
        expect(request.context).toBe(eventContexts.at(-1));
        expect(request.collection).toBe(app.db.getCollection(sourceName));
        if (guardMode === 'async') return Promise.resolve() as never;
        if (guardMode === 'invalid') return false as never;
        if (guardMode === 'throw') throw new Error('Database source read refused');
        return boundary.assert(request, selected);
      });
      trigger.load(persisted);
      const first = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Old source', amount: 140 } });
      expect(first.status).toBe(200);
      await waitForWorkflowIdle(app);
      const sourceRows = [...baselineRows, { id: 2, name: 'Old source', amount: 140, tenantId: 'B' }];
      const targetRows = [{ id: 1, name: 'Old source evaluated', amount: 140, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(sourceRows);
      expect(await rows(targetName)).toEqual(targetRows);
      expect(eventModels).toHaveLength(1);
      expect(eventModels[0].get('name')).toBe('Old source evaluated');
      const executions = await workflow.getExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0].authContext).toEqual({ currentUserId: user.id, currentRole: role });
      expect(executions[0].tenantId).toBe('B');
      expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      const jobs = await executions[0].getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].nodeId).toBe(create.id);
      expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
      selected.push(sourceIdentity);
      const visible = await agent()
        .resource(sourceName)
        .list({ sort: ['id'] });
      expect(visible.status).toBe(200);
      expect(visible.body.data).toEqual(sourceRows);
      const denied = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Selected source', amount: 140 } });
      expect(denied.status).toBe(400);
      expect(denied.body.errors[0].message).toMatch(/dedicated adapter/);
      await waitForWorkflowIdle(app);
      expect(await rows(sourceName)).toEqual(sourceRows);
      expect(await rows(targetName)).toEqual(targetRows);
      expect((await workflow.getExecutions()).map((execution) => execution.id)).toEqual([executions[0].id]);
      expect(observed).toEqual([{ currentTenantId: 'B', currentUserId: user.id, currentRole: role }]);
      expect(eventModels).toHaveLength(2);
      expect(eventModels[1].get('name')).toBe('Selected source');
      for (const mode of ['async', 'invalid', 'throw'] as const) {
        guardMode = mode;
        const refused = await agent()
          .resource(sourceName)
          .create({ values: { name: `Guard ${mode}`, amount: 140 } });
        expect(refused.status).toBe(500);
        expect(refused.body.errors[0].message).toMatch(
          mode === 'throw' ? /Database source read refused/ : /undefined synchronously/,
        );
        await waitForWorkflowIdle(app);
        expect(await rows(sourceName)).toEqual(sourceRows);
        expect(await rows(targetName)).toEqual(targetRows);
        expect((await workflow.getExecutions()).map((execution) => execution.id)).toEqual([executions[0].id]);
        expect(eventModels.at(-1).get('name')).toBe(`Guard ${mode}`);
        expect(observed).toEqual([{ currentTenantId: 'B', currentUserId: user.id, currentRole: role }]);
      }
      guardMode = 'normal';
      selected.pop();
      const resumed = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Resumed source', amount: 140 } });
      expect(resumed.status).toBe(200);
      await waitForWorkflowIdle(app);
      expect(await rows(sourceName)).toEqual([
        ...sourceRows,
        { id: 3, name: 'Resumed source', amount: 140, tenantId: 'B' },
      ]);
      const finalTargets = [...targetRows, { id: 2, name: 'Resumed source evaluated', amount: 140, tenantId: 'B' }];
      expect(await rows(targetName)).toEqual(finalTargets);
      const list = await agent()
        .resource(targetName)
        .list({ sort: ['id'] });
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(finalTargets);
      expect(await workflow.getExecutions()).toHaveLength(2);
      expect(observed).toEqual([
        { currentTenantId: 'B', currentUserId: user.id, currentRole: role },
        { currentTenantId: 'B', currentUserId: user.id, currentRole: role },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
