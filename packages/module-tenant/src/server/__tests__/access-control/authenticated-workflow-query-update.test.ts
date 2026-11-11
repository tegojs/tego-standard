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
import { AccessMainWorkflowQueryRuntime } from '../../access-control/main-workflow-query-runtime';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated query-to-update workflows', () => {
  // Query visibility must not expand the downstream node's ownership scope.
  // 查询可见性不能扩大下游更新节点的归属性范围。
  it('passes the queried key through real jobs while restricting the update to owned rows', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let writeRuntime: AccessMainWorkflowWriteRuntime;
    let queryRuntime: AccessMainWorkflowQueryRuntime;
    let source: AccessCollectionIdentity;
    let plugin: WorkflowPlugin;
    const observed: object[] = [];
    const role = 'pipeline-member';
    const password = 'pipeline-password';
    const collectionName = 'pipelineTasks';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      const observe = (request) => {
        const authority = plugin.captureDataOperationAuthority(request);
        observed.push({
          action: authority.actionName,
          nodeId: authority.nodeId,
          executionId: authority.executionId,
          state: { ...authority.identityContext.state },
        });
      };
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
              queryResolver: (request) => {
                observe(request);
                return queryRuntime.resolve(request, [source]);
              },
              updateResolver: (request) => {
                observe(request);
                return writeRuntime.resolveUpdate(request, [source]);
              },
              updateTransactionPlanner: (target) => writeRuntime.plan(target, [source]),
            },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      writeRuntime = new AccessMainWorkflowWriteRuntime(app, (request) =>
        plugin.captureDataOperationAuthority(request),
      );
      queryRuntime = new AccessMainWorkflowQueryRuntime(app, (request) =>
        plugin.captureDataOperationAuthority(request),
      );
      app.db.registerModels({ EventSourceModel, WebhookCategories });
      app.db.collection(webhooksCollection);
      app.db.collection(webhookCategoriesCollection);
      await app.db.sync();
      for (const id of ['B', 'C']) {
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      }
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
      {
        const actions = [
          { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
          { name: 'create', fields: ['name', 'amount'] },
        ];
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: { dataSourceKey: 'main', roleName: role, name: collectionName, usingActionsConfig: true, actions },
        });
        const persisted = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        const normalize = (values) =>
          values
            .map(({ name, fields }) => ({ name, fields: [...fields].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name));
        expect(
          normalize(persisted.map((action) => ({ name: action.get('name'), fields: action.get('fields') }))),
        ).toEqual(normalize(actions));
      }
      await app.db.collection(accessConfigHistory).model.sync();
      const config = configFor({
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
      });
      const visibility = configFor(
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Visible C' },
        },
        'visibility',
      );
      await writeRuntime.registry.store.save(
        source,
        {
          ...config,
          revision: 0,
          rules: [...config.rules, { ...visibility.rules[0], id: 'known-visible-row' }],
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', writeRuntime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        writeRuntime.registry.select(ctx, adapter, [source.collectionKey]),
      );
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'pipelineEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Query then update',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'pipelineEvents', mode: 1 },
        },
      });
      const query = await workflow.createNode({
        type: 'query',
        config: {
          collection: collectionName,
          multiple: false,
          failOnEmpty: true,
          params: { filter: { id: '{{$context.data.id}}' }, fields: ['id', 'name', 'amount', 'tenantId'] },
        },
      });
      const update = await workflow.createNode({
        type: 'update',
        config: {
          collection: collectionName,
          params: {
            filter: { id: `{{$jobsMapByNodeKey.${query.key}.id}}` },
            values: { name: 'Workflow approved' },
          },
        },
        upstreamId: query.id,
      });
      await query.setDownstream(update);
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Pipeline intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'pipelineIntake',
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
          resourceName: 'pipelineIntake',
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
          .set('X-Tenant-Id', tenant);
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const initialRows = [
        { id: 1, name: 'Owned B', amount: 120, tenantId: 'B' },
        { id: 2, name: 'Visible C', amount: 140, tenantId: 'C' },
      ];
      for (const row of initialRows) {
        const response = await agent(row.tenantId)
          .resource(collectionName)
          .create({ values: { name: row.name, amount: row.amount } });
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ keys: [row.id], affected: 1 });
      }
      expect(await rows()).toEqual(initialRows);
      const initialList = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(initialList.status).toBe(200);
      expect(initialList.body.data).toEqual(initialRows);
      // Automatic nodes retain their existing authority, independently of human HTTP update ACL.
      // 自动节点保留原操作权威，人工HTTP更新仍按自己的ACL拒绝。
      const direct = await agent()
        .resource(collectionName)
        .update({
          filterByTk: 1,
          values: { name: 'Manual update denied' },
        });
      expect(direct.status).toBe(403);
      expect(await rows()).toEqual(initialRows);
      const cases = [
        { id: 2, updated: false },
        { id: 1, updated: true },
      ];
      const finalRows = [{ ...initialRows[0], name: 'Workflow approved' }, initialRows[1]];
      for (const [index, entry] of cases.entries()) {
        const response = await agent()
          .resource('pipelineIntake')
          .submit({ values: { id: entry.id } });
        expect([200, 204]).toContain(response.status);
        await waitForWorkflowIdle(app);
        expect(await rows()).toEqual(entry.updated ? finalRows : initialRows);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions).toHaveLength(index + 1);
        const execution = executions[index];
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
        expect(jobs).toHaveLength(2);
        expect(jobs[0].nodeId).toBe(query.id);
        expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
        expect(jobs[0].result).toEqual(initialRows[entry.id - 1]);
        expect(jobs[1].nodeId).toBe(update.id);
        expect(jobs[1].upstreamId).toBe(jobs[0].id);
        expect(jobs[1].status).toBe(JOB_STATUS.RESOLVED);
        expect(jobs[1].result).toEqual(entry.updated ? { length: 1, data: [finalRows[0]] } : { length: 0, data: [] });
      }
      const finalList = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(finalList.status).toBe(200);
      expect(finalList.body.data).toEqual(finalRows);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(observed).toEqual(
        cases.flatMap((entry, index) => {
          const state = { currentTenantId: 'B', currentUserId: user.id, currentRole: role };
          return [
            { action: 'list', nodeId: query.id, executionId: executions[index].id, state },
            { action: 'update', nodeId: update.id, executionId: executions[index].id, state },
          ];
        }),
      );
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
