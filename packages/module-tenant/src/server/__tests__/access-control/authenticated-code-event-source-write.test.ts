import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import ModuleEventSourceServer from '../../../../../module-event-source/src/server';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { PluginWebhook } from '../../../../../module-event-source/src/server/webhooks/Plugin';
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

describe.skipIf(!coreEntry)('authenticated code event-source business writes', () => {
  // The native code endpoint returns the last job directly; its writes still need current G and tenant facts.
  // 原生代码入口直接返回最后的任务结果，业务写入仍须通过当前 G 和租户边界。
  it('uses the authenticated request tenant and node authority through the registered code endpoint', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let plugin: WorkflowPlugin;
    let runtime: AccessMainWorkflowWriteRuntime;
    let source: AccessCollectionIdentity;
    const observed: object[] = [];
    const role = 'code-intake-member';
    const collectionName = 'codeIntakeBusinessTasks';
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
          [
            ModuleEventSourceServer,
            { name: 'event-source', packageName: '@tachybase/module-event-source', workspaceSource: true },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      const eventPlugin = app.pm.get('event-source') as ModuleEventSourceServer;
      const webhooks = eventPlugin.featureInstances.find(
        (feature) => feature instanceof PluginWebhook,
      ) as PluginWebhook;
      expect(webhooks).toBeInstanceOf(PluginWebhook);
      webhooks.queueWorker.stop();
      runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'B', name: 'B', enabled: true },
          { id: 'C', name: 'C', enabled: true },
        ],
      });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const password = 'code-intake-password';
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
          actions: [{ name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] }],
        },
      });
      expect(
        (await resource.getActions()).map((action) => ({
          name: action.get('name'),
          fields: [...action.get('fields')].sort(),
        })),
      ).toEqual([{ name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] }]);
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
        values: { name: 'codeIntakeEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Code intake business create',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'codeIntakeEvents', mode: 1 },
        },
      });
      const node = await workflow.createNode({
        type: 'create',
        config: {
          collection: collectionName,
          params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
        },
      });
      const code = 'ctx.body = ctx.action.params.values;';
      const event = await app.db.getRepository('webhooks').create({
        values: { name: 'code-business-intake', type: 'code', enabled: true, workflowKey: workflow.key, code },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect(persisted.toJSON()).toMatchObject({
        name: 'code-business-intake',
        type: 'code',
        enabled: true,
        workflowKey: workflow.key,
        code,
      });
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
          .set('X-Tenant-Id', 'C');
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const denied = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Manual denied', amount: 140 } });
      expect(denied.status).toBe(403);
      expect(await rows()).toEqual([]);
      const expectedRows = [{ id: 1, name: 'Accepted code intake', amount: 140, tenantId: 'C' }];
      for (const [index, values] of [
        { name: 'Excluded code intake', amount: 80 },
        { name: 'Accepted code intake', amount: 140 },
      ].entries()) {
        const response = await agent().resource('webhooks').trigger({ name: event.name, values });
        expect(response.status).toBe(200);
        await waitForWorkflowIdle(app);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions).toHaveLength(index + 1);
        const execution = executions[index];
        expect(execution.context.data).toEqual(values);
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('C');
        expect(execution.tenantContext.currentTenantId).toBe('C');
        expect(execution.status).toBe(index === 0 ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(node.id);
        expect(jobs[0].status).toBe(index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
        if (index === 0) expect(jobs[0].result.message).toMatch(/Record is unavailable/);
        else {
          expect(jobs[0].result).toEqual(expectedRows[0]);
          expect(response.body).toEqual(expectedRows[0]);
        }
        expect(await rows()).toEqual(index === 0 ? [] : expectedRows);
      }
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(observed).toEqual(
        executions.map((execution) => ({
          action: 'create',
          nodeId: node.id,
          executionId: execution.id,
          state: { currentTenantId: 'C', currentUserId: user.id, currentRole: role },
        })),
      );
      const list = await agent().resource(collectionName).list({});
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(expectedRows);
      expect(await app.db.getRepository('eventSourceQueueJobs').count()).toBe(0);
      expect((await app.db.getRepository('users').findOne({ filterByTk: user.id })).get('defaultTenantId')).toBe('B');
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
