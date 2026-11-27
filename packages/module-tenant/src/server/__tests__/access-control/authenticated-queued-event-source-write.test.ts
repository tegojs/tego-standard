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
import { ResourceEventTrigger } from '../../../../../module-event-source/src/server/trigger/ResourceEventTrigger';
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

describe.skipIf(!coreEntry)('authenticated queued event-source business writes', () => {
  // Losing the original actor/tenant, using the default tenant, or bypassing G must fail.
  // 丢失原用户或租户、回退默认租户或跳过G时，本验收必须失败。
  it.each(['customAction', 'afterResource'] as const)(
    'preserves the request tenant and G in queued %s writes',
    async (stage) => {
      let app: MockServer;
      let worker: EventSourceQueueWorker;
      let unregister: (() => void) | undefined;
      let runtime: AccessMainWorkflowWriteRuntime;
      let source: AccessCollectionIdentity;
      let plugin: WorkflowPlugin;
      const observed: object[] = [];
      const role = 'queued-intake-member';
      const password = 'queued-intake-password';
      const collectionName = 'queuedIntakeTasks';
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
                  return runtime.resolveCreate(request, [source]);
                },
                createTransactionPlanner: (target) => runtime.plan(target, [source]),
              },
            ],
          ],
        });
        plugin = app.pm.get('workflow') as WorkflowPlugin;
        expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
        runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
        app.db.registerModels({ EventSourceModel, WebhookCategories });
        for (const collection of [webhooksCollection, webhookCategoriesCollection, queueCollection])
          app.db.collection(collection);
        await app.db.sync();
        worker = new EventSourceQueueWorker(app);
        (app as any).eventSourceQueueWorker = worker;
        await app.db.getRepository('tenants').create({
          values: [
            { id: 'B', name: 'B', enabled: true },
            { id: 'C', name: 'C', enabled: true },
          ],
        });
        await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
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
            fields: [
              { name: 'name', type: 'string' },
              { name: 'amount', type: 'integer' },
            ],
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
              { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
              { name: 'create', fields: ['name', 'amount'] },
            ],
          },
        });
        expect(
          (await resource.getActions())
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          { name: 'create', fields: ['amount', 'name'] },
          { name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] },
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
                  operator: 'gte',
                  left: { type: 'field', path: 'amount' },
                  right: { type: 'literal', value: 100 },
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
        const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
        unregister = adapter.register();
        registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
          runtime.registry.select(ctx, adapter, [source.collectionKey]),
        );
        await app.db.getRepository('collections').create({
          context: {},
          values: { name: 'queuedIntakeEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
        });
        if (stage === 'afterResource') {
          await app.db.getRepository('collections').create({
            context: {},
            values: {
              name: 'queuedResourceInputs',
              tenancy: 'shared',
              timestamps: false,
              createdBy: false,
              updatedBy: false,
              fields: [
                { name: 'name', type: 'string' },
                { name: 'amount', type: 'integer' },
              ],
            },
          });
          const inputResource = await app.db.getRepository('dataSourcesRolesResources').create({
            values: {
              dataSourceKey: 'main',
              roleName: role,
              name: 'queuedResourceInputs',
              usingActionsConfig: true,
              actions: [{ name: 'create', fields: ['name', 'amount'] }],
            },
          });
          expect(
            (await inputResource.getActions()).map((action) => ({
              name: action.get('name'),
              fields: [...action.get('fields')].sort(),
            })),
          ).toEqual([{ name: 'create', fields: ['amount', 'name'] }]);
        }
        const workflow = await app.db.getRepository('workflows').create({
          values: {
            title: 'Queued intake create',
            type: 'collection',
            enabled: true,
            sync: true,
            config: { collection: 'queuedIntakeEvents', mode: 1 },
          },
        });
        const create = await workflow.createNode({
          type: 'create',
          config: {
            collection: collectionName,
            params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
          },
        });
        const eventOptions = {
          resourceName: stage === 'customAction' ? 'queuedTaskIntake' : 'queuedResourceInputs',
          actionName: stage === 'customAction' ? 'submit' : 'create',
          executionMode: 'queue',
          maxAttempts: 1,
        };
        const event = await app.db.getRepository('webhooks').create({
          values: {
            name: 'Queued intake',
            type: stage === 'customAction' ? 'resource' : stage,
            enabled: true,
            workflowKey: workflow.key,
            code: 'ctx.body = ctx.action.params.values;',
            options: eventOptions,
          },
        });
        const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
        expect(persisted).toBeInstanceOf(EventSourceModel);
        expect(persisted.options).toEqual(eventOptions);
        if (stage === 'customAction') new CustomActionTrigger(app).load(persisted);
        else {
          const trigger = new ResourceEventTrigger(app);
          trigger.load(persisted);
          trigger.afterAllLoad();
        }
        const login = await app
          .agent()
          .post('/auth:signIn')
          .set('X-Authenticator', 'basic')
          .send({ account: role, password });
        expect(login.status).toBe(200);
        expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
        const token = login.body.data.token;
        expect(token).toEqual(expect.any(String));
        const agent = (tenant = 'B') =>
          app
            .agent()
            .set('Authorization', `Bearer ${token}`)
            .set('X-Authenticator', 'basic')
            .set('X-Role', role)
            .set('X-Tenant-ID', tenant);
        const checked = await agent().get('/auth:check');
        expect(checked.status).toBe(200);
        expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
        const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
        expect(await rows()).toEqual([]);
        const baseline = await agent()
          .resource(collectionName)
          .create({ values: { name: 'HTTP baseline', amount: 120 } });
        expect(baseline.status).toBe(200);
        expect(baseline.body.data).toEqual({ keys: [1], affected: 1 });
        const baselineRows = [{ id: 1, name: 'HTTP baseline', amount: 120, tenantId: 'B' }];
        expect(await rows()).toEqual(baselineRows);
        for (const values of [
          { name: 'Excluded queued intake', amount: 80 },
          { name: 'Accepted queued intake', amount: 140 },
        ]) {
          const response = await agent('C').resource(eventOptions.resourceName)[eventOptions.actionName]({ values });
          expect(response.status).toBe(200);
          if (stage === 'customAction') expect(response.body).toEqual({ queued: true });
          else expect(response.body.data).toMatchObject(values);
        }
        const queue = app.db.getRepository('eventSourceQueueJobs');
        const jobs = () => queue.find({ sort: ['id'] });
        const inputRows =
          stage === 'afterResource'
            ? () => app.db.getCollection('queuedResourceInputs').model.findAll({ raw: true, order: [['id', 'ASC']] })
            : async () => [];
        const expectedInputs =
          stage === 'afterResource'
            ? [
                { id: 1, name: 'Excluded queued intake', amount: 80 },
                { id: 2, name: 'Accepted queued intake', amount: 140 },
              ]
            : [];
        expect(await inputRows()).toEqual(expectedInputs);
        expect((await jobs()).map((job) => job.get('status'))).toEqual([
          EVENT_SOURCE_QUEUE_STATUS.PENDING,
          EVENT_SOURCE_QUEUE_STATUS.PENDING,
        ]);
        expect(await rows()).toEqual(baselineRows);
        worker.start();
        await expect
          .poll(
            async () =>
              (await jobs())
                .map((job) => job.get('status'))
                .every((status) =>
                  [EVENT_SOURCE_QUEUE_STATUS.SUCCESS, EVENT_SOURCE_QUEUE_STATUS.DEAD].includes(status),
                ),
            { timeout: 20000 },
          )
          .toBe(true);
        worker.stop();
        await waitForWorkflowIdle(app);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect({
          rows: await rows(),
          queue: (await jobs()).map((job) => ({ status: job.get('status'), attempt: job.get('attempt') })),
          executions: executions.map((execution) => ({
            auth: execution.authContext,
            tenant: execution.tenantId,
            status: execution.status,
          })),
        }).toEqual({
          rows: [...baselineRows, { id: 2, name: 'Accepted queued intake', amount: 140, tenantId: 'C' }],
          queue: [
            { status: EVENT_SOURCE_QUEUE_STATUS.DEAD, attempt: 1 },
            { status: EVENT_SOURCE_QUEUE_STATUS.SUCCESS, attempt: 1 },
          ],
          executions: [
            { auth: { currentUserId: user.id, currentRole: role }, tenant: 'C', status: EXECUTION_STATUS.ERROR },
            { auth: { currentUserId: user.id, currentRole: role }, tenant: 'C', status: EXECUTION_STATUS.RESOLVED },
          ],
        });
        expect(executions).toHaveLength(2);
        expect(
          (await jobs()).map((job) => ({
            sourceId: job.get('sourceId'),
            stage: job.get('stage'),
            workflowKey: job.get('workflowKey'),
            context: job.get('contextLite'),
            payload: job.get('payload'),
          })),
        ).toEqual([
          {
            sourceId: event.id,
            stage,
            workflowKey: workflow.key,
            context: { userId: user.id, roleName: role, tenantId: 'C' },
            payload: { name: 'Excluded queued intake', amount: 80 },
          },
          {
            sourceId: event.id,
            stage,
            workflowKey: workflow.key,
            context: { userId: user.id, roleName: role, tenantId: 'C' },
            payload: { name: 'Accepted queued intake', amount: 140 },
          },
        ]);
        expect((await jobs())[0].get('lastError')).toMatch(/Record is unavailable/);
        expect((await jobs())[1].get('lastError')).toBeNull();
        expect(await inputRows()).toEqual(expectedInputs);
        for (const [index, execution] of executions.entries()) {
          expect(execution.tenantContext.currentTenantId).toBe('C');
          const savedJobs = await execution.getJobs();
          expect(savedJobs).toHaveLength(1);
          expect(savedJobs[0].nodeId).toBe(create.id);
          expect(savedJobs[0].status).toBe(index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
          if (index === 0) expect(savedJobs[0].result.message).toMatch(/Record is unavailable/);
        }
        expect(observed).toEqual([
          { currentTenantId: 'C', currentUserId: user.id, currentRole: role },
          { currentTenantId: 'C', currentUserId: user.id, currentRole: role },
        ]);
        const list = await agent('C').resource(collectionName).list({});
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([{ id: 2, name: 'Accepted queued intake', amount: 140, tenantId: 'C' }]);
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
    },
  );
});
