import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import webhookCategoriesCollection from '../../../../../module-event-source/src/server/collections/webhookCategories';
import webhooksCollection from '../../../../../module-event-source/src/server/collections/webhooks';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { WebhookCategories } from '../../../../../module-event-source/src/server/model/WebhookCategories';
import { CustomActionTrigger } from '../../../../../module-event-source/src/server/trigger/CustomctionTrigger';
import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import type { AccessCondition } from '../../access-control/types';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated loop workflow business updates', () => {
  // A repeated node must resolve each item separately; visible-only iterations cannot borrow an earlier write.
  // 重复节点须逐项解析；仅可见的迭代不得借用前一次写入权限。
  it('updates each eligible loop item with the persisted actor and leaves V-only items unchanged', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let identity: AccessCollectionIdentity;
    let plugin: WorkflowPlugin;
    const observed: object[] = [];
    const creatorRole = 'loop-creator';
    const operatorRole = 'loop-operator';
    const password = 'loop-password';
    const collectionName = 'loopBusinessTasks';
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
              updateResolver: (request) => {
                const authority = plugin.captureDataOperationAuthority(request);
                observed.push({
                  action: authority.actionName,
                  nodeId: authority.nodeId,
                  executionId: authority.executionId,
                  state: { ...authority.identityContext.state },
                });
                return runtime.resolveUpdate(request, [identity]);
              },
              updateTransactionPlanner: (target) => runtime.plan(target, [identity]),
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
      for (const id of ['B', 'C']) {
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      }
      for (const name of [creatorRole, operatorRole]) {
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      }
      const user = await app.db.getRepository('users').create({
        values: {
          username: 'loop-member',
          password,
          roles: [creatorRole, operatorRole],
          tenants: ['B', 'C'],
          defaultTenantId: 'B',
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
            { name: 'amount', type: 'integer' },
          ],
        },
      });
      identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      for (const roleName of [creatorRole, operatorRole]) {
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName,
            name: collectionName,
            usingActionsConfig: true,
            actions: [
              { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
              ...(roleName === creatorRole ? [{ name: 'create', fields: ['name', 'amount'] }] : []),
            ],
          },
        });
        const actions = await resource.getActions();
        expect(
          actions
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          ...(roleName === creatorRole ? [{ name: 'create', fields: ['amount', 'name'] }] : []),
          { name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] },
        ]);
      }
      const subject = (roleName: string): AccessCondition => ({
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
            operator: 'eq',
            left: { type: 'context', path: 'role.name' },
            right: { type: 'literal', value: roleName },
          },
        ],
      });
      const creator = configFor(ownerCondition);
      const operator = configFor({
        type: 'all',
        children: [
          ownerCondition,
          {
            type: 'compare',
            operator: 'gte',
            left: { type: 'field', path: 'amount' },
            right: { type: 'literal', value: 100 },
          },
        ],
      });
      const visibility = configFor({ type: 'constant', value: true }, 'visibility');
      await app.db.collection(accessConfigHistory).model.sync();
      await runtime.registry.store.save(
        identity,
        {
          ...creator,
          revision: 0,
          rules: [
            { ...creator.rules[0], id: 'creator-owned', subject: subject(creatorRole) },
            { ...operator.rules[0], id: 'operator-eligible', subject: subject(operatorRole) },
            { ...visibility.rules[0], id: 'operator-known-visible', subject: subject(operatorRole) },
          ],
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        runtime.registry.select(ctx, adapter, [identity.collectionKey]),
      );
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'loopEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Update eligible items in a loop',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'loopEvents', mode: 1 },
        },
      });
      const loop = await workflow.createNode({
        type: 'loop',
        config: { target: '{{$context.data.items}}' },
      });
      const update = await workflow.createNode({
        type: 'update',
        upstreamId: loop.id,
        branchIndex: 0,
        config: {
          collection: collectionName,
          params: {
            filter: { id: `{{$scopes.${loop.id}.item.id}}` },
            values: { name: `{{$scopes.${loop.id}.item.name}}` },
          },
        },
      });
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Loop intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'loopIntake',
            actionName: 'submit',
            executionMode: 'inline',
            failurePolicy: 'block',
          },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect({ code: persisted.code, workflowKey: persisted.workflowKey, options: persisted.options }).toEqual({
        code: 'ctx.body = ctx.action.params.values;',
        workflowKey: workflow.key,
        options: {
          resourceName: 'loopIntake',
          actionName: 'submit',
          executionMode: 'inline',
          failurePolicy: 'block',
        },
      });
      new CustomActionTrigger(app).load(persisted);
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: 'loop-member', password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = (role = operatorRole, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const initial = [
        { id: 1, name: 'First eligible B', amount: 120, tenantId: 'B' },
        { id: 2, name: 'Visible other C', amount: 140, tenantId: 'C' },
        { id: 3, name: 'Visible low B', amount: 5, tenantId: 'B' },
        { id: 4, name: 'Last eligible B', amount: 160, tenantId: 'B' },
      ];
      for (const row of initial) {
        const created = await agent(creatorRole, row.tenantId)
          .resource(collectionName)
          .create({ values: { name: row.name, amount: row.amount } });
        expect(created.status).toBe(200);
        expect(created.body.data).toEqual({ keys: [row.id], affected: 1 });
      }
      expect(await rows()).toEqual(initial);
      const before = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(before.status).toBe(200);
      expect(before.body.data).toEqual(initial);
      const direct = await agent()
        .resource(collectionName)
        .update({
          filterByTk: 1,
          values: { name: 'Manual update denied' },
        });
      expect(direct.status).toBe(403);
      expect(await rows()).toEqual(initial);
      expect(await workflow.countExecutions()).toBe(0);
      const items = [
        { id: 1, name: 'First approved' },
        { id: 2, name: 'Other tenant forbidden' },
        { id: 3, name: 'Low amount forbidden' },
        { id: 4, name: 'Last approved' },
      ];
      const response = await agent().resource('loopIntake').submit({ values: { items } });
      expect([200, 204]).toContain(response.status);
      await waitForWorkflowIdle(app);
      const final = [
        { id: 1, name: 'First approved', amount: 120, tenantId: 'B' },
        { id: 2, name: 'Visible other C', amount: 140, tenantId: 'C' },
        { id: 3, name: 'Visible low B', amount: 5, tenantId: 'B' },
        { id: 4, name: 'Last approved', amount: 160, tenantId: 'B' },
      ];
      expect(await rows()).toEqual(final);
      const listed = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(final);
      const executions = await workflow.getExecutions();
      expect(executions).toHaveLength(1);
      const execution = executions[0];
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: operatorRole });
      expect(execution.tenantId).toBe('B');
      expect(execution.tenantContext.currentTenantId).toBe('B');
      expect(execution.context.data).toEqual({ items });
      const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
      expect(jobs).toHaveLength(5);
      expect({ nodeId: jobs[0].nodeId, status: jobs[0].status, result: jobs[0].result }).toEqual({
        nodeId: loop.id,
        status: JOB_STATUS.RESOLVED,
        result: 4,
      });
      const updates = jobs.slice(1);
      expect(new Set(updates.map((job) => job.id)).size).toBe(4);
      expect(updates.map((job) => ({ nodeId: job.nodeId, upstreamId: job.upstreamId, status: job.status }))).toEqual(
        Array.from({ length: 4 }, () => ({
          nodeId: update.id,
          upstreamId: jobs[0].id,
          status: JOB_STATUS.RESOLVED,
        })),
      );
      expect(updates.map((job) => job.result)).toEqual([
        { length: 1, data: [{ id: 1, name: 'First approved', amount: 120, tenantId: 'B' }] },
        { length: 0, data: [] },
        { length: 0, data: [] },
        { length: 1, data: [{ id: 4, name: 'Last approved', amount: 160, tenantId: 'B' }] },
      ]);
      expect(observed).toEqual(
        Array.from({ length: 4 }, () => ({
          action: 'update',
          nodeId: update.id,
          executionId: execution.id,
          state: { currentTenantId: 'B', currentUserId: user.id, currentRole: operatorRole },
        })),
      );
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
