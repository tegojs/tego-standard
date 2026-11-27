import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

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

describe.skipIf(!coreEntry)('authenticated workflow test business writes', () => {
  // Testing a draft executes real nodes: entry permission must not bypass the node's G boundary.
  // 测试草稿会真实执行节点，入口权限不能绕过节点的 G 边界。
  it('requires test-entry permission and preserves the tester identity and tenant in selected creates', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let plugin: WorkflowPlugin;
    let source: AccessCollectionIdentity;
    const observed: object[] = [];
    const testerRole = 'workflow-draft-tester';
    const ordinaryRole = 'workflow-draft-member';
    const collectionName = 'draftTestBusinessTasks';
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
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'B', name: 'B', enabled: true },
          { id: 'C', name: 'C', enabled: true },
        ],
      });
      const actors = [];
      for (const [name, snippets] of [
        [ordinaryRole, []],
        [testerRole, ['pm.workflow.workflows']],
      ] as const) {
        const role = await app.db.getRepository('roles').create({
          values: { name, strategy: { actions: [] }, snippets },
        });
        expect(role.get('strategy')).toEqual({ actions: [] });
        expect(role.get('snippets')).toEqual(snippets);
        const password = `${name}-password`;
        const user = await app.db.getRepository('users').create({
          values: { username: name, password, roles: [name], tenants: ['B'], defaultTenantId: 'B' },
        });
        const login = await app
          .agent()
          .post('/auth:signIn')
          .set('X-Authenticator', 'basic')
          .send({ account: name, password });
        expect(login.status).toBe(200);
        expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
        const token = login.body.data.token;
        expect(token).toEqual(expect.any(String));
        const agent = () =>
          app
            .agent()
            .set('Authorization', `Bearer ${token}`)
            .set('X-Authenticator', 'basic')
            .set('X-Role', name)
            .set('X-Tenant-Id', 'B');
        const check = await agent().get('/auth:check');
        expect(check.status).toBe(200);
        expect(check.body.data).toMatchObject({ id: user.id, hasPassword: true });
        actors.push({ user, agent });
      }
      const [ordinary, tester] = actors;
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
          roleName: testerRole,
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
                right: { type: 'literal', value: String(tester.user.id) },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: testerRole },
              },
            ],
          }),
          revision: 0,
        },
        { userId: tester.user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        runtime.registry.select(ctx, adapter, [source.collectionKey]),
      );
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'draftTestEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Draft business create test',
          type: 'collection',
          enabled: false,
          sync: true,
          config: { collection: 'draftTestEvents', mode: 1 },
        },
      });
      const node = await workflow.createNode({
        type: 'create',
        config: {
          collection: collectionName,
          params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
        },
      });
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      expect(await workflow.countExecutions()).toBe(0);
      const deniedEntry = await ordinary
        .agent()
        .resource('workflows')
        .test({
          filterByTk: workflow.id,
          values: { data: { name: 'Denied ordinary test', amount: 140 } },
        });
      expect(deniedEntry.status).toBe(403);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await rows()).toEqual([]);
      expect(observed).toEqual([]);
      const deniedDirect = await tester
        .agent()
        .resource(collectionName)
        .create({
          values: { name: 'Denied manual create', amount: 140 },
        });
      expect(deniedDirect.status).toBe(403);
      expect(await rows()).toEqual([]);
      const expectedRows = [{ id: 1, name: 'Accepted draft test', amount: 140, tenantId: 'B' }];
      for (const [index, data] of [
        { name: 'Excluded draft test', amount: 80, tenantId: 'C' },
        { name: 'Accepted draft test', amount: 140, tenantId: 'C' },
      ].entries()) {
        const response = await tester.agent().resource('workflows').test({
          filterByTk: workflow.id,
          values: { data },
        });
        expect(response.status).toBe(200);
        await waitForWorkflowIdle(app);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions).toHaveLength(index + 1);
        const execution = executions[index];
        const status = index === 0 ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED;
        expect(execution.status).toBe(status);
        expect(execution.authContext).toEqual({ currentUserId: tester.user.id, currentRole: testerRole });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.context.data).toEqual(data);
        expect(response.body.data).toMatchObject({
          id: execution.id,
          status,
          tenantId: 'B',
          authContext: { currentUserId: tester.user.id, currentRole: testerRole },
        });
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(node.id);
        expect(jobs[0].status).toBe(index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
        if (index === 0) expect(jobs[0].result.message).toMatch(/Record is unavailable/);
        else expect(jobs[0].result).toEqual(expectedRows[0]);
        expect(await rows()).toEqual(index === 0 ? [] : expectedRows);
      }
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(observed).toEqual(
        executions.map((execution) => ({
          action: 'create',
          nodeId: node.id,
          executionId: execution.id,
          state: { currentTenantId: 'B', currentUserId: tester.user.id, currentRole: testerRole },
        })),
      );
      const list = await tester.agent().resource(collectionName).list({});
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(expectedRows);
      await workflow.reload();
      expect(workflow.enabled).toBe(false);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
