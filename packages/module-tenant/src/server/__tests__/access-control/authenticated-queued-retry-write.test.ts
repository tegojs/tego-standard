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

describe.skipIf(!coreEntry)('authenticated queued business write retries', () => {
  // Swallowing a failed write, retaining partial data, or losing identity on retry must fail.
  // 吞掉失败、保留半成品或重试时丢失身份必须导致本验收失败。
  it('rolls back a failed attempt and automatically retries once with the original user and request tenant', async () => {
    let app: MockServer;
    let worker: EventSourceQueueWorker;
    let unregister: (() => void) | undefined;
    let plugin: WorkflowPlugin;
    let runtime: AccessMainWorkflowWriteRuntime;
    let source: AccessCollectionIdentity;
    const observed: object[] = [];
    const role = 'queued-retry-member';
    const collectionName = 'queuedRetryTasks';
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
      const password = 'queued-retry-password';
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
        values: { name: 'queuedRetryEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Queued retry check',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'queuedRetryEvents', mode: 1 },
        },
      });
      const node = await workflow.createNode({
        type: 'create',
        config: { collection: collectionName, params: { values: { name: '{{$context.data.name}}' } } },
      });
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Queued retry intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'queuedRetryIntake',
            actionName: 'submit',
            executionMode: 'queue',
            maxAttempts: 2,
            retryBackoffMs: 5000,
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
      let failBusinessWrite = true;
      const written: object[] = [];
      app.db.on(`${collectionName}.afterCreate`, (record) => {
        if (record.get('name') !== 'Queued C task') return;
        written.push({ id: record.get('id'), name: record.get('name'), tenantId: record.get('tenantId') });
        if (failBusinessWrite) throw new Error('Transient queued business failure');
      });
      const response = await agent('C')
        .resource('queuedRetryIntake')
        .submit({ values: { name: 'Queued C task' } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ queued: true });
      const queue = app.db.getRepository('eventSourceQueueJobs');
      const queued = () => queue.find({ sort: ['id'] });
      const [pending] = await queued();
      expect(pending.get('status')).toBe(EVENT_SOURCE_QUEUE_STATUS.PENDING);
      expect(pending.get('attempt')).toBe(0);
      expect(pending.get('maxAttempts')).toBe(2);
      expect(pending.get('retryBackoffMs')).toBe(5000);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await rows()).toEqual(baselineRows);
      worker.start();
      await expect
        .poll(
          async () => {
            const [job] = await queued();
            if (job.get('status') === EVENT_SOURCE_QUEUE_STATUS.FAILED) worker.stop();
            return job.get('status');
          },
          { timeout: 20000, interval: 20 },
        )
        .toBe(EVENT_SOURCE_QUEUE_STATUS.FAILED);
      await expect.poll(() => (worker as any).running, { timeout: 10000 }).toBe(false);
      await waitForWorkflowIdle(app);
      const [failed] = await queued();
      expect(failed.id).toBe(pending.id);
      expect(failed.get('attempt')).toBe(1);
      expect(failed.get('lastError')).toMatch(/Transient queued business failure/);
      expect(failed.get('nextRunAt')).toBeInstanceOf(Date);
      expect(failed.get('nextRunAt').getTime()).toBeGreaterThan(failed.get('lockedAt').getTime());
      expect(await rows()).toEqual(baselineRows);
      expect(written).toEqual([{ id: 2, name: 'Queued C task', tenantId: 'C' }]);
      const [firstExecution] = await workflow.getExecutions();
      expect(firstExecution.status).toBe(EXECUTION_STATUS.ERROR);
      const [firstJob] = await firstExecution.getJobs();
      expect(firstJob.status).toBe(JOB_STATUS.ERROR);
      expect(firstJob.result.message).toMatch(/Transient queued business failure/);
      // Resume the original timer; do not call processJob, enqueue again, or alter persisted queue state.
      // 恢复原计时器，不直接调用处理器、重新入队或改写持久队列状态。
      failBusinessWrite = false;
      worker.start();
      await expect
        .poll(async () => (await queued())[0].get('status'), { timeout: 20000 })
        .toBe(EVENT_SOURCE_QUEUE_STATUS.SUCCESS);
      worker.stop();
      await expect.poll(() => (worker as any).running, { timeout: 10000 }).toBe(false);
      await waitForWorkflowIdle(app);
      const finished = await queued();
      expect(finished).toHaveLength(1);
      expect({
        id: finished[0].id,
        status: finished[0].get('status'),
        attempt: finished[0].get('attempt'),
        lastError: finished[0].get('lastError'),
        sourceId: finished[0].get('sourceId'),
        workflowKey: finished[0].get('workflowKey'),
        context: finished[0].get('contextLite'),
        payload: finished[0].get('payload'),
      }).toEqual({
        id: pending.id,
        status: EVENT_SOURCE_QUEUE_STATUS.SUCCESS,
        attempt: 2,
        lastError: null,
        sourceId: event.id,
        workflowKey: workflow.key,
        context: { userId: user.id, roleName: role, tenantId: 'C' },
        payload: { name: 'Queued C task' },
      });
      const expectedRows = [...baselineRows, { id: 2, name: 'Queued C task', tenantId: 'C' }];
      expect(await rows()).toEqual(expectedRows);
      expect(written).toEqual([
        { id: 2, name: 'Queued C task', tenantId: 'C' },
        { id: 2, name: 'Queued C task', tenantId: 'C' },
      ]);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(2);
      expect(executions[0].id).toBe(firstExecution.id);
      for (const [index, execution] of executions.entries()) {
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('C');
        expect(execution.tenantContext.currentTenantId).toBe('C');
        expect(execution.status).toBe(index === 0 ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(node.id);
        expect(jobs[0].status).toBe(index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
        if (index === 0) expect(jobs[0].result.message).toMatch(/Transient queued business failure/);
        else expect(jobs[0].result).toEqual(expectedRows[1]);
      }
      expect(observed).toEqual(
        executions.map((execution) => ({
          action: 'create',
          nodeId: node.id,
          executionId: execution.id,
          state: { currentTenantId: 'C', currentUserId: user.id, currentRole: role },
        })),
      );
      const list = await agent('C').resource(collectionName).list({});
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([expectedRows[1]]);
      expect((await app.db.getRepository('users').findOne({ filterByTk: user.id })).get('defaultTenantId')).toBe('B');
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
