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

describe.skipIf(!coreEntry)('authenticated paginated workflow selections', () => {
  // Paging before authorization, losing an array item, or creating from an empty failed page must fail.
  // 先分页后授权、丢失多值结果或空页失败后仍新增，都必须被验收捕获。
  it('pages authorized scalar summaries into receipts and stops writes on an empty page', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let plugin: WorkflowPlugin;
    let reads: AccessMainWorkflowQueryRuntime;
    let writes: AccessMainWorkflowWriteRuntime;
    const selected: AccessCollectionIdentity[] = [];
    const observed: object[] = [];
    const role = 'paged-selection-editor';
    const password = 'paged-selection-password';
    const sourceName = 'pagedSelectionTasks';
    const outputName = 'pagedSelectionReceipts';
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
            fields: name === sourceName ? [{ name: 'name', type: 'string' }] : [{ name: 'names', type: 'json' }],
          },
        });
        const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
        selected.push(identity);
        const actions =
          name === sourceName
            ? [
                { name: 'list', fields: ['id', 'name', 'tenantId'] },
                { name: 'create', fields: ['name'] },
              ]
            : [{ name: 'list', fields: ['id', 'names', 'tenantId'] }];
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: { dataSourceKey: 'main', roleName: role, name, usingActionsConfig: true, actions },
        });
        expect(
          (await resource.getActions())
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(
          name === sourceName
            ? [
                { name: 'create', fields: ['name'] },
                { name: 'list', fields: ['id', 'name', 'tenantId'] },
              ]
            : [{ name: 'list', fields: ['id', 'names', 'tenantId'] }],
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
        values: { name: 'pagedSelectionEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Paged selection receipts',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'pagedSelectionEvents', mode: 1 },
        },
      });
      const select = await workflow.createNode({
        type: 'select',
        config: {
          collection: sourceName,
          multiple: true,
          failOnEmpty: true,
          params: {
            fields: ['name'],
            summary: 'name',
            page: '{{$context.data.page}}',
            pageSize: 2,
            sort: [{ field: 'id', direction: 'asc' }],
          },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        upstreamId: select.id,
        config: { collection: outputName, params: { values: { names: `{{$jobsMapByNodeKey.${select.key}}}` } } },
      });
      await select.setDownstream(create);
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Paged selection intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'pagedSelectionIntake',
            actionName: 'submit',
            executionMode: 'inline',
            failurePolicy: 'block',
          },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect(persisted.options).toEqual({
        resourceName: 'pagedSelectionIntake',
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
          .set('X-Tenant-ID', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = async (name: string) => {
        const stored = await app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
        // Decode only the SQLite raw JSON storage, without using presentation getters.
        // 仅解码 SQLite 原始 JSON 存储，不使用展示 getter。
        return name === outputName
          ? stored.map((row) => ({ ...row, names: typeof row.names === 'string' ? JSON.parse(row.names) : row.names }))
          : stored;
      };
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(outputName)).toEqual([]);
      const sources = [
        { id: 1, name: 'C first', tenantId: 'C' },
        { id: 2, name: 'B first', tenantId: 'B' },
        { id: 3, name: 'C middle', tenantId: 'C' },
        { id: 4, name: 'B second', tenantId: 'B' },
        { id: 5, name: 'B third', tenantId: 'B' },
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
        .create({ values: { names: ['Manual receipt'] } });
      expect(denied.status).toBe(403);
      expect(await rows(outputName)).toEqual([]);
      const receipts = [
        { id: 1, names: ['B first', 'B second'], tenantId: 'B' },
        { id: 2, names: ['B third'], tenantId: 'B' },
      ];
      for (const page of [1, 2, 3]) {
        const response = await agent().resource('pagedSelectionIntake').submit({ values: { page } });
        expect(response.status).toBe(page === 3 ? 500 : 200);
        await waitForWorkflowIdle(app);
        expect(await rows(sourceName)).toEqual(sources);
        expect(await rows(outputName)).toEqual(page === 1 ? [receipts[0]] : receipts);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions).toHaveLength(page);
        const execution = executions[page - 1];
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.status).toBe(page === 3 ? EXECUTION_STATUS.FAILED : EXECUTION_STATUS.RESOLVED);
        const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
        expect(jobs).toHaveLength(page === 3 ? 1 : 2);
        expect(jobs[0].nodeId).toBe(select.id);
        expect(jobs[0].status).toBe(page === 3 ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED);
        expect(jobs[0].result).toEqual(page === 3 ? [] : receipts[page - 1].names);
        if (page !== 3) {
          expect(jobs[1].nodeId).toBe(create.id);
          expect(jobs[1].upstreamId).toBe(jobs[0].id);
          expect(jobs[1].status).toBe(JOB_STATUS.RESOLVED);
          expect(jobs[1].result).toEqual(receipts[page - 1]);
        }
      }
      const list = await agent()
        .resource(outputName)
        .list({ sort: ['id'] });
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(receipts);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      const state = { currentTenantId: 'B', currentUserId: user.id, currentRole: role };
      expect(observed).toEqual([
        { action: 'list', nodeId: select.id, executionId: executions[0].id, state },
        { action: 'create', nodeId: create.id, executionId: executions[0].id, state },
        { action: 'list', nodeId: select.id, executionId: executions[1].id, state },
        { action: 'create', nodeId: create.id, executionId: executions[1].id, state },
        { action: 'list', nodeId: select.id, executionId: executions[2].id, state },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
