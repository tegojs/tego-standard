import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business request interception', () => {
  // A rejected pre-save workflow must not leave a business row behind or be skipped by selected writes.
  // 保存前校验拒绝时不得留下业务行，也不得被选中写入跳过。
  const modes = [
    { selected: false, global: true },
    { selected: true, global: true },
    { selected: false, global: false },
    { selected: true, global: false },
  ];
  it.each(modes)('validates saves (selected: $selected, global: $global)', async ({ selected, global }) => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const role = 'interception-creator';
    const deniedRole = 'interception-without-actions';
    const password = 'interception-password';
    const collectionName = 'interceptionTasks';
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
            },
          ],
        ],
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [role, deniedRole]) {
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      }
      const user = await app.db.getRepository('users').create({
        values: {
          username: role,
          password,
          roles: [role, deniedRole],
          tenants: ['B'],
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
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'create', fields: ['name'] },
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
          ],
        },
      });
      const actions = await resource.getActions();
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
      ]);
      const registry = new AccessMainRootResourceRegistry(app);
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      await registry.store.save(
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
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
      );
      const plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Validate a business submission',
          type: 'request-interception',
          enabled: true,
          sync: true,
          config: { collection: collectionName, global, actions: ['create'] },
        },
      });
      const condition = await workflow.createNode({
        type: 'condition',
        config: {
          calculation: { calculator: 'equal', operands: ['{{$context.params.values.name}}', 'Rejected'] },
        },
      });
      const message = await workflow.createNode({
        type: 'response-message',
        upstreamId: condition.id,
        branchIndex: 1,
        config: { message: 'This harmless submission is rejected' },
      });
      const end = await workflow.createNode({
        type: 'end',
        upstreamId: message.id,
        config: { endStatus: JOB_STATUS.REJECTED },
      });
      await message.setDownstream(end);
      expect(plugin.enabledCache.get(workflow.id)?.key).toBe(workflow.key);
      // The ordinary submit button emits key! and an empty before-workflow selector for local bindings.
      // 普通提交按钮的本地绑定发送 key!，同时保留空的前置工作流选择串。
      const binding = global ? {} : { triggerWorkflows: `${workflow.key}!`, beforeWorkflows: '' };
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      expect(signedIn.body.data.token).toEqual(expect.any(String));
      const agent = (currentRole = role) =>
        app
          .agent()
          .set('Authorization', `Bearer ${signedIn.body.data.token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', currentRole)
          .set('X-Tenant-Id', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const forbidden = await agent(deniedRole)
        .resource(collectionName)
        .create({ values: { name: 'Rejected' }, ...binding });
      expect(forbidden.status).toBe(403);
      expect(await rows()).toEqual([]);
      expect(await workflow.countExecutions()).toBe(0);
      const accepted = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Accepted' }, ...binding });
      const initial = [{ id: 1, name: 'Accepted', tenantId: 'B' }];
      expect({ status: accepted.status, rows: await rows(), executions: await workflow.countExecutions() }).toEqual({
        status: 200,
        rows: initial,
        executions: 1,
      });
      expect(await rows()).toEqual(initial);
      const rejected = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Rejected' }, ...binding });
      expect({
        status: rejected.status,
        rows: await rows(),
        executions: (await workflow.getExecutions({ order: [['id', 'ASC']] })).map((execution) => ({
          status: execution.status,
          name: execution.context.params.values.name,
        })),
      }).toEqual({
        status: 400,
        rows: initial,
        executions: [
          { status: EXECUTION_STATUS.RESOLVED, name: 'Accepted' },
          { status: EXECUTION_STATUS.REJECTED, name: 'Rejected' },
        ],
      });
      expect(rejected.body.errors).toEqual([{ message: 'This harmless submission is rejected' }]);
      expect(await rows()).toEqual(initial);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(2);
      for (const [index, execution] of executions.entries()) {
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.context).toMatchObject({
          user: { id: user.id },
          roleName: role,
          params: { values: { name: index === 0 ? 'Accepted' : 'Rejected' } },
        });
      }
      expect(executions.map((execution) => execution.status)).toEqual([
        EXECUTION_STATUS.RESOLVED,
        EXECUTION_STATUS.REJECTED,
      ]);
      const jobs = await executions[1].getJobs({ order: [['id', 'ASC']] });
      expect(jobs.map((job) => ({ nodeId: job.nodeId, status: job.status, result: job.result }))).toEqual([
        { nodeId: condition.id, status: JOB_STATUS.RESOLVED, result: true },
        { nodeId: message.id, status: JOB_STATUS.RESOLVED, result: 'This harmless submission is rejected' },
        { nodeId: end.id, status: JOB_STATUS.REJECTED, result: 'This harmless submission is rejected' },
      ]);
      const listed = await agent().resource(collectionName).list();
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(initial);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
