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

describe.skipIf(!coreEntry)('authenticated pre-save successful interception', () => {
  // A resolved End intentionally stops saving; neither early dispatch nor unconditional stopping is valid.
  // 正常结束节点可以有意停止保存；提前写入和一律停止都违反原生契约。
  it('keeps a successfully intercepted update unchanged and still saves requests that continue', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const role = 'intercepted-update-editor';
    const deniedRole = 'intercepted-update-without-actions';
    const collectionName = 'interceptedUpdateTasks';
    const writes: string[] = [];
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [WorkflowPlugin, { name: 'workflow', packageName: '@tachybase/module-workflow', workspaceSource: true }],
        ],
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [role, deniedRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'intercepted-update-password';
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role, deniedRole], tenants: ['B'], defaultTenantId: 'B' },
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
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
            { name: 'create', fields: ['name'] },
            { name: 'update', fields: ['name'] },
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
        { name: 'update', fields: ['name'] },
      ]);
      const source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      await registry.store.save(
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
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      let selected = false;
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, selected ? [source.collectionKey] : []),
      );
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = (roleName = role) =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName)
          .set('X-Tenant-ID', 'B');
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const seeded = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Draft task' } });
      expect(seeded.status).toBe(200);
      const initial = [{ id: 1, name: 'Draft task', tenantId: 'B' }];
      expect(await rows()).toEqual(initial);
      app.db.on(`${collectionName}.afterUpdateWithAssociations`, async (record) => {
        writes.push(record.get('name'));
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Accept submission without saving',
          type: 'request-interception',
          enabled: true,
          sync: true,
          config: { collection: collectionName, global: false, actions: ['update'] },
        },
      });
      const condition = await workflow.createNode({
        type: 'condition',
        config: { calculation: { calculator: 'equal', operands: ['{{$context.params.values.name}}', 'Skip saving'] } },
      });
      const message = await workflow.createNode({
        type: 'response-message',
        upstreamId: condition.id,
        branchIndex: 1,
        config: { message: 'Submission accepted without saving' },
      });
      const end = await workflow.createNode({
        type: 'end',
        upstreamId: message.id,
        config: { endStatus: JOB_STATUS.RESOLVED },
      });
      await message.setDownstream(end);
      const plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(plugin.enabledCache.get(workflow.id)?.key).toBe(workflow.key);
      const binding = { triggerWorkflows: `${workflow.key}!`, beforeWorkflows: '' };
      const update = (name: string, roleName = role, bound = true) =>
        agent(roleName)
          .resource(collectionName)
          .update({
            filterByTk: 1,
            values: { name },
            ...(bound ? binding : {}),
          });
      const legacy = await update('Skip saving');
      expect(legacy.status).toBe(200);
      expect(legacy.body).toEqual({ messages: [{ message: 'Submission accepted without saving' }] });
      expect(await rows()).toEqual(initial);
      expect(writes).toEqual([]);
      expect(await workflow.countExecutions()).toBe(1);

      selected = true;
      const forbidden = await update('Skip saving', deniedRole);
      expect(forbidden.status).toBe(403);
      expect(await rows()).toEqual(initial);
      expect(writes).toEqual([]);
      expect(await workflow.countExecutions()).toBe(1);
      const intercepted = await update('Skip saving');
      expect(intercepted.status).toBe(200);
      expect(intercepted.body).toEqual({ messages: [{ message: 'Submission accepted without saving' }] });
      expect(await rows()).toEqual(initial);
      expect(writes).toEqual([]);
      expect(await workflow.countExecutions()).toBe(2);
      const unbound = await update('Unbound edit', role, false);
      expect(unbound.status).toBe(200);
      expect(unbound.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Unbound edit', tenantId: 'B' }]);
      expect(await workflow.countExecutions()).toBe(2);
      const continued = await update('Applied edit');
      expect(continued.status).toBe(200);
      expect(continued.body.data).toEqual({ keys: [1], affected: 1 });
      const final = [{ id: 1, name: 'Applied edit', tenantId: 'B' }];
      expect(await rows()).toEqual(final);
      expect(writes).toEqual(['Unbound edit', 'Applied edit']);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(3);
      for (const [index, execution] of executions.entries()) {
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.context).toMatchObject({
          user: { id: user.id },
          roleName: role,
          params: { values: { name: index < 2 ? 'Skip saving' : 'Applied edit' } },
        });
        expect(String(execution.context.params.filterByTk)).toBe('1');
        const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
        expect(jobs.map((job) => ({ nodeId: job.nodeId, status: job.status, result: job.result }))).toEqual(
          index < 2
            ? [
                { nodeId: condition.id, status: JOB_STATUS.RESOLVED, result: true },
                { nodeId: message.id, status: JOB_STATUS.RESOLVED, result: 'Submission accepted without saving' },
                { nodeId: end.id, status: JOB_STATUS.RESOLVED, result: 'Submission accepted without saving' },
              ]
            : [{ nodeId: condition.id, status: JOB_STATUS.RESOLVED, result: false }],
        );
      }
      const listed = await agent().resource(collectionName).list({});
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(final);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
