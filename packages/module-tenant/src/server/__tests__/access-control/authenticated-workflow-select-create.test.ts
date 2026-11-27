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

describe.skipIf(!coreEntry)('authenticated select-to-create workflows', () => {
  // A scalar select result must retain its read boundary before becoming a new business value.
  // 单值选择结果写入新业务记录之前，仍须遵守来源读取边界。
  it('creates a receipt from the selected scalar and stops downstream writes when the source is unavailable', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let plugin: WorkflowPlugin;
    let reads: AccessMainWorkflowQueryRuntime;
    let writes: AccessMainWorkflowWriteRuntime;
    const selected: AccessCollectionIdentity[] = [];
    const observed: object[] = [];
    const role = 'selection-receipt-editor';
    const sourceName = 'selectionBusinessTasks';
    const outputName = 'selectionBusinessReceipts';
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
              selectResolver: (request) => {
                observe(request);
                return reads.resolve(request, selected);
              },
              createResolver: (request) => {
                observe(request);
                return writes.resolveCreate(request, selected);
              },
              createTransactionPlanner: (target) => writes.plan(target, selected),
            },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      reads = new AccessMainWorkflowQueryRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      writes = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      app.db.registerModels({ EventSourceModel, WebhookCategories });
      app.db.collection(webhooksCollection);
      app.db.collection(webhookCategoriesCollection);
      await app.db.sync();
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const password = 'selection-receipt-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      await app.db.collection(accessConfigHistory).model.sync();
      for (const name of [sourceName, outputName]) {
        const stored = await app.db.getRepository('collections').create({
          context: {},
          values: {
            name,
            tenancy: 'tenantScoped',
            timestamps: false,
            createdBy: false,
            updatedBy: false,
            fields: [{ name: 'name', type: 'string' }],
          },
        });
        const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
        selected.push(identity);
        const actions = [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
          ...(name === sourceName ? [{ name: 'create', fields: ['name'] }] : []),
        ];
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: { dataSourceKey: 'main', roleName: role, name, usingActionsConfig: true, actions },
        });
        expect(
          (await resource.getActions())
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(
          actions
            .map((action) => ({ name: action.name, fields: [...action.fields].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        await writes.registry.store.save(
          identity,
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
      }
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', writes.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        writes.registry.select(
          ctx,
          adapter,
          selected.map((identity) => identity.collectionKey),
        ),
      );
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'selectionReceiptEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Select a business name then create its receipt',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'selectionReceiptEvents', mode: 1 },
        },
      });
      const select = await workflow.createNode({
        type: 'select',
        config: {
          collection: sourceName,
          multiple: false,
          failOnEmpty: true,
          params: { filter: { id: '{{$context.data.id}}' }, fields: ['name'], summary: 'name' },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        config: {
          collection: outputName,
          params: { values: { name: '{{$jobsMapByNodeKey.' + select.key + '}}' } },
        },
        upstreamId: select.id,
      });
      await select.setDownstream(create);
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Selection receipt intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'selectionReceiptIntake',
            actionName: 'submit',
            executionMode: 'inline',
            failurePolicy: 'block',
          },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect(persisted.workflowKey).toBe(workflow.key);
      expect(persisted.code).toBe('ctx.body = ctx.action.params.values;');
      expect(persisted.options).toEqual({
        resourceName: 'selectionReceiptIntake',
        actionName: 'submit',
        executionMode: 'inline',
        failurePolicy: 'block',
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
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const rows = (name: string) => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(outputName)).toEqual([]);
      const sources = [
        { id: 1, name: 'Owned B task', tenantId: 'B' },
        { id: 2, name: 'Owned C task', tenantId: 'C' },
      ];
      for (const row of sources) {
        const result = await agent(row.tenantId)
          .resource(sourceName)
          .create({ values: { name: row.name } });
        expect(result.status).toBe(200);
        expect(result.body.data).toEqual({ keys: [row.id], affected: 1 });
      }
      expect(await rows(sourceName)).toEqual(sources);
      const denied = await agent()
        .resource(outputName)
        .create({ values: { name: 'Manual receipt denied' } });
      expect(denied.status).toBe(403);
      expect(await rows(outputName)).toEqual([]);
      const receipts = [{ id: 1, name: 'Owned B task', tenantId: 'B' }];
      for (const [index, id] of [2, 1].entries()) {
        const response = await agent().resource('selectionReceiptIntake').submit({ values: { id } });
        if (id === 2) expect(response.status).toBe(500);
        else expect([200, 204]).toContain(response.status);
        await waitForWorkflowIdle(app);
        expect(await rows(sourceName)).toEqual(sources);
        expect(await rows(outputName)).toEqual(id === 2 ? [] : receipts);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions).toHaveLength(index + 1);
        const execution = executions[index];
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.status).toBe(id === 2 ? EXECUTION_STATUS.FAILED : EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
        expect(jobs).toHaveLength(id === 2 ? 1 : 2);
        expect(jobs[0].nodeId).toBe(select.id);
        expect(jobs[0].status).toBe(id === 2 ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED);
        if (id === 1) {
          expect(jobs[0].result).toBe('Owned B task');
          expect(jobs[1].nodeId).toBe(create.id);
          expect(jobs[1].upstreamId).toBe(jobs[0].id);
          expect(jobs[1].status).toBe(JOB_STATUS.RESOLVED);
          expect(jobs[1].result).toEqual(receipts[0]);
        }
      }
      const sourceList = await agent()
        .resource(sourceName)
        .list({ sort: ['id'] });
      expect(sourceList.status).toBe(200);
      expect(sourceList.body.data).toEqual([sources[0]]);
      const outputList = await agent()
        .resource(outputName)
        .list({ sort: ['id'] });
      expect(outputList.status).toBe(200);
      expect(outputList.body.data).toEqual(receipts);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      const state = { currentTenantId: 'B', currentUserId: user.id, currentRole: role };
      expect(observed).toEqual([
        { action: 'list', nodeId: select.id, executionId: executions[0].id, state },
        { action: 'list', nodeId: select.id, executionId: executions[1].id, state },
        { action: 'create', nodeId: create.id, executionId: executions[1].id, state },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
