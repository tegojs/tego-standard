import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import queueCollection from '../../../../../module-event-source/src/server/collections/eventSourceQueueJobs';
import webhookCategoriesCollection from '../../../../../module-event-source/src/server/collections/webhookCategories';
import webhooksCollection from '../../../../../module-event-source/src/server/collections/webhooks';
import { EVENT_SOURCE_QUEUE_STATUS } from '../../../../../module-event-source/src/server/constants';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { WebhookCategories } from '../../../../../module-event-source/src/server/model/WebhookCategories';
import { EventSourceQueueWorker } from '../../../../../module-event-source/src/server/queue/EventSourceQueueWorker';
import { CustomActionTrigger } from '../../../../../module-event-source/src/server/trigger/CustomctionTrigger';
import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated queued writes after tenant shutdown', () => {
  // A queued tenant ID is provenance, not proof that the tenant is still enabled at execution.
  // 队列中的租户 ID 说明任务来源，不证明执行时租户仍然启用。
  it('rejects an already queued write for a stopped tenant and still delivers the active tenant task', async () => {
    let app: MockServer;
    let worker: EventSourceQueueWorker;
    let unregister: (() => void) | undefined;
    let plugin: WorkflowPlugin;
    let runtime: AccessMainWorkflowWriteRuntime;
    let source: AccessCollectionIdentity;
    const observed: object[] = [];
    const role = 'queued-tenant-stop-member';
    const collectionName = 'queuedTenantStopTasks';
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
                observed.push({
                  action: authority.actionName,
                  nodeId: authority.nodeId,
                  executionId: authority.executionId,
                  state: { ...authority.identityContext.state },
                });
                return runtime.resolveCreate(request, [source]);
              },
              createTransactionPlanner: (target) => runtime.plan(target, [source]),
            },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      app.db.registerModels({ EventSourceModel, WebhookCategories });
      for (const collection of [webhooksCollection, webhookCategoriesCollection, queueCollection])
        app.db.collection(collection);
      await app.db.sync();
      worker = new EventSourceQueueWorker(app);
      (app as any).eventSourceQueueWorker = worker;
      const tenants = app.db.getRepository('tenants');
      await tenants.create({
        values: [
          { id: 'B', name: 'B', enabled: true },
          { id: 'C', name: 'C', enabled: true },
        ],
      });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const password = 'queued-tenant-stop-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
            { name: 'create', fields: ['name'] },
          ],
        },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
      ]);
      await app.db.collection(accessConfigHistory).model.sync();
      await runtime.registry.store.save(
        source,
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
            ],
          }),
          revision: 0,
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        runtime.registry.select(ctx, adapter, [source.collectionKey]),
      );
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'queuedTenantStopEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Queued tenant shutdown check',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'queuedTenantStopEvents', mode: 1 },
        },
      });
      const node = await workflow.createNode({
        type: 'create',
        config: { collection: collectionName, params: { values: { name: '{{$context.data.name}}' } } },
      });
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Queued tenant shutdown intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'queuedTenantStopIntake',
            actionName: 'submit',
            executionMode: 'queue',
            maxAttempts: 1,
          },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      new CustomActionTrigger(app).load(persisted);
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = (tenant: string) =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const check = await agent('B').get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const baseline = await agent('B')
        .resource(collectionName)
        .create({ values: { name: 'Existing B task' } });
      expect(baseline.status).toBe(200);
      expect(baseline.body.data).toEqual({ keys: [1], affected: 1 });
      const baselineRows = [{ id: 1, name: 'Existing B task', tenantId: 'B' }];
      const payloads = [{ name: 'Queued B task' }, { name: 'Queued C task' }];
      for (const [index, tenant] of ['B', 'C'].entries()) {
        const response = await agent(tenant).resource('queuedTenantStopIntake').submit({ values: payloads[index] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ queued: true });
      }
      const queue = app.db.getRepository('eventSourceQueueJobs');
      const queued = () => queue.find({ sort: ['id'] });
      expect((await queued()).map((job) => job.get('status'))).toEqual([
        EVENT_SOURCE_QUEUE_STATUS.PENDING,
        EVENT_SOURCE_QUEUE_STATUS.PENDING,
      ]);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await rows()).toEqual(baselineRows);
      await tenants.update({ filterByTk: 'B', values: { enabled: false } });
      expect(
        (await tenants.find({ sort: ['id'] })).map((tenant) => ({
          id: tenant.get('id'),
          enabled: tenant.get('enabled'),
        })),
      ).toEqual([
        { id: 'B', enabled: false },
        { id: 'C', enabled: true },
      ]);
      worker.start();
      await expect
        .poll(
          async () =>
            (await queued())
              .map((job) => job.get('status'))
              .every((status) => [EVENT_SOURCE_QUEUE_STATUS.DEAD, EVENT_SOURCE_QUEUE_STATUS.SUCCESS].includes(status)),
          { timeout: 20000 },
        )
        .toBe(true);
      worker.stop();
      await waitForWorkflowIdle(app);
      const finished = await queued();
      expect(
        finished.map((job) => ({
          status: job.get('status'),
          attempt: job.get('attempt'),
          sourceId: job.get('sourceId'),
          workflowKey: job.get('workflowKey'),
          context: job.get('contextLite'),
          payload: job.get('payload'),
        })),
      ).toEqual(
        ['B', 'C'].map((tenant, index) => ({
          status: index === 0 ? EVENT_SOURCE_QUEUE_STATUS.DEAD : EVENT_SOURCE_QUEUE_STATUS.SUCCESS,
          attempt: 1,
          sourceId: event.id,
          workflowKey: workflow.key,
          context: { userId: user.id, roleName: role, tenantId: tenant },
          payload: payloads[index],
        })),
      );
      expect(finished[0].get('lastError')).toMatch(/Current tenant is missing or disabled/);
      expect(finished[1].get('lastError')).toBeNull();
      const expectedRows = [...baselineRows, { id: 2, name: 'Queued C task', tenantId: 'C' }];
      expect(await rows()).toEqual(expectedRows);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(2);
      for (const [index, execution] of executions.entries()) {
        const tenant = index === 0 ? 'B' : 'C';
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe(tenant);
        expect(execution.tenantContext.currentTenantId).toBe(tenant);
        expect(execution.status).toBe(index === 0 ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(node.id);
        expect(jobs[0].status).toBe(index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
        if (index === 0) expect(jobs[0].result.message).toMatch(/Current tenant is missing or disabled/);
        else expect(jobs[0].result).toEqual(expectedRows[1]);
      }
      expect(observed).toEqual(
        executions.map((execution, index) => ({
          action: 'create',
          nodeId: node.id,
          executionId: execution.id,
          state: { currentTenantId: index === 0 ? 'B' : 'C', currentUserId: user.id, currentRole: role },
        })),
      );
      const list = await agent('C').resource(collectionName).list({});
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([expectedRows[1]]);
      expect((await tenants.findOne({ filterByTk: 'B' })).get('enabled')).toBe(false);
      expect(
        (await app.db.getRepository('tenantUsers').find({ filter: { userId: user.id } }))
          .map((membership) => membership.get('tenantId'))
          .sort(),
      ).toEqual(['B', 'C']);
    } finally {
      worker?.stop();
      if (worker) await expect.poll(() => (worker as any).running, { timeout: 10000 }).toBe(false);
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
