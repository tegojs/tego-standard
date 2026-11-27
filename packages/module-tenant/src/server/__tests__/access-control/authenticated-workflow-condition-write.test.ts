import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import webhookCategoriesCollection from '../../../../../module-event-source/src/server/collections/webhookCategories';
import webhooksCollection from '../../../../../module-event-source/src/server/collections/webhooks';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { WebhookCategories } from '../../../../../module-event-source/src/server/model/WebhookCategories';
import { CustomActionTrigger } from '../../../../../module-event-source/src/server/trigger/CustomctionTrigger';
import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { BRANCH_INDEX } from '../../../../../module-workflow/src/server/instructions/ConditionInstruction';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated workflow condition business writes', () => {
  // Wrong branches, continuing after a denied write, or losing node identity/G must fail.
  // 错走分支、拒绝后仍继续写入或丢失节点身份/G时，本验收必须失败。
  it('stops after an excluded branch and continues only after an authorized branch write', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let source: AccessCollectionIdentity;
    let plugin: WorkflowPlugin;
    const observed: object[] = [];
    const role = 'condition-task-member';
    const password = 'condition-task-password';
    const collectionName = 'conditionBusinessTasks';
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
      app.db.collection(webhooksCollection);
      app.db.collection(webhookCategoriesCollection);
      await app.db.sync();
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
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
          actions: [{ name: 'list', fields: ['id', 'name', 'tenantId'] }],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(actions.map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))).toEqual(
        [{ name: 'list', fields: ['id', 'name', 'tenantId'] }],
      );
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
                operator: 'ne',
                left: { type: 'field', path: 'name' },
                right: { type: 'literal', value: 'Excluded task' },
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
        values: { name: 'conditionTaskEvents', tenancy: 'shared', fields: [{ name: 'accepted', type: 'boolean' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Condition task intake',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'conditionTaskEvents', mode: 1 },
        },
      });
      const condition = await workflow.createNode({
        type: 'condition',
        config: { calculation: { calculator: 'isTrue', operands: ['{{$context.data.accepted}}'] } },
      });
      const approved = await workflow.createNode({
        type: 'create',
        upstreamId: condition.id,
        branchIndex: BRANCH_INDEX.ON_TRUE,
        config: { collection: collectionName, params: { values: { name: 'Approved task' } } },
      });
      const excluded = await workflow.createNode({
        type: 'create',
        upstreamId: condition.id,
        branchIndex: BRANCH_INDEX.ON_FALSE,
        config: { collection: collectionName, params: { values: { name: 'Excluded task' } } },
      });
      const continuation = await workflow.createNode({
        type: 'create',
        upstreamId: condition.id,
        config: { collection: collectionName, params: { values: { name: 'Continuation task' } } },
      });
      await condition.setDownstream(continuation);
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Condition task intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'conditionTaskIntake',
            actionName: 'submit',
            executionMode: 'inline',
            failurePolicy: 'block',
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
      const agent = () =>
        app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', role);
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const manual = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Approved task' } });
      expect(manual.status).toBe(403);
      expect(await rows()).toEqual([]);
      const denied = await agent()
        .resource('conditionTaskIntake')
        .submit({ values: { accepted: false } });
      expect(denied.status).toBe(500);
      await waitForWorkflowIdle(app);
      expect(await rows()).toEqual([]);
      const accepted = await agent()
        .resource('conditionTaskIntake')
        .submit({ values: { accepted: true } });
      expect([200, 204]).toContain(accepted.status);
      await waitForWorkflowIdle(app);
      const expectedRows = [
        { id: 1, name: 'Approved task', tenantId: 'B' },
        { id: 2, name: 'Continuation task', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expectedRows);
      const list = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(expectedRows);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(2);
      for (const [index, execution] of executions.entries()) {
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.status).toBe(index === 0 ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
        expect(jobs.map((job) => job.nodeId)).toEqual(
          index === 0 ? [condition.id, excluded.id] : [condition.id, approved.id, continuation.id],
        );
        expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
        expect(jobs[0].result).toBe(index === 1);
        for (const job of jobs.slice(1)) expect(job.upstreamId).toBe(jobs[0].id);
        expect(jobs[1].status).toBe(index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
        if (index === 0) expect(jobs[1].result.message).toMatch(/Record is unavailable/);
        else expect(jobs[2].status).toBe(JOB_STATUS.RESOLVED);
      }
      const state = { currentTenantId: 'B', currentUserId: user.id, currentRole: role };
      expect(observed).toEqual([
        { action: 'create', nodeId: excluded.id, executionId: executions[0].id, state },
        { action: 'create', nodeId: approved.id, executionId: executions[1].id, state },
        { action: 'create', nodeId: continuation.id, executionId: executions[1].id, state },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
