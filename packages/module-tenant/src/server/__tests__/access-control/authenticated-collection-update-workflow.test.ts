import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowCollectionReadBoundary } from '../../access-control/main-workflow-collection-read-boundary';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated collection update workflow writes', () => {
  // Dropping changed fields, authenticated context or the caller transaction must change the outcome.
  // 丢失变更字段、认证上下文或调用方事务时，真实业务与执行结果必须让测试失败。
  it('runs only for changed amounts and rolls back downstream output with a failed source update', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let boundary: AccessMainWorkflowCollectionReadBoundary;
    let plugin: WorkflowPlugin;
    const selected: AccessCollectionIdentity[] = [];
    const observed: { state: object; transaction: Transaction }[] = [];
    const role = 'collection-update-editor';
    const deniedRole = 'collection-update-without-actions';
    const password = 'collection-update-password';
    const sourceName = 'collectionUpdateInputs';
    const targetName = 'collectionUpdateOutputs';
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
              collectionReadGuard: (request) => boundary.assert(request, selected),
              createResolver: (request) => {
                const authority = plugin.captureDataOperationAuthority(request);
                observed.push({ state: { ...authority.identityContext.state }, transaction: request.transaction });
                return runtime.resolveCreate(request, selected);
              },
              createTransactionPlanner: (target) => runtime.plan(target, selected),
            },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      expect(app.getPlugin(WorkflowPlugin)).toBe(plugin);
      runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      boundary = new AccessMainWorkflowCollectionReadBoundary(app);
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
      await app.db.collection(accessConfigHistory).model.sync();
      for (const collectionName of [sourceName, targetName]) {
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
        const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
        selected.push(identity);
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName: role,
            name: collectionName,
            usingActionsConfig: true,
            actions: [
              { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
              ...(collectionName === sourceName
                ? [
                    { name: 'create', fields: ['name', 'amount'] },
                    { name: 'update', fields: ['name', 'amount'] },
                  ]
                : []),
            ],
          },
        });
        const actions = await resource.getActions();
        expect(
          actions
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          ...(collectionName === sourceName ? [{ name: 'create', fields: ['amount', 'name'] }] : []),
          { name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] },
          ...(collectionName === sourceName ? [{ name: 'update', fields: ['amount', 'name'] }] : []),
        ]);
        await runtime.registry.store.save(
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
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        runtime.registry.select(
          ctx,
          adapter,
          selected.map((identity) => identity.collectionKey),
        ),
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
          .set('X-Tenant-Id', 'B');
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const rows = (name: string, transaction: Transaction | null = null) =>
        app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']], transaction });
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(targetName)).toEqual([]);
      const created = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Initial input', amount: 120 } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows(sourceName)).toEqual([{ id: 1, name: 'Initial input', amount: 120, tenantId: 'B' }]);

      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Publish an amount change',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: sourceName, mode: 2, changed: ['amount'] },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        config: {
          collection: targetName,
          params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
        },
      });
      const deniedTarget = await agent()
        .resource(targetName)
        .create({ values: { name: 'Manual output', amount: 140 } });
      expect(deniedTarget.status).toBe(403);
      const deniedSource = await agent(deniedRole)
        .resource(sourceName)
        .update({ filterByTk: 1, values: { amount: 140 } });
      expect(deniedSource.status).toBe(403);
      expect(await rows(sourceName)).toEqual([{ id: 1, name: 'Initial input', amount: 120, tenantId: 'B' }]);
      expect(await rows(targetName)).toEqual([]);
      expect(await workflow.getExecutions()).toEqual([]);
      expect(observed).toEqual([]);

      const renamed = await agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Edited input' } });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toEqual({ keys: [1], affected: 1 });
      const unchanged = [{ id: 1, name: 'Edited input', amount: 120, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(unchanged);
      expect(await rows(targetName)).toEqual([]);
      expect(await workflow.getExecutions()).toEqual([]);
      expect(observed).toEqual([]);

      let reject = true;
      let committed = 0;
      const late: {
        transaction: Transaction;
        source: unknown;
        target: unknown;
        executionStatuses: number[];
      }[] = [];
      app.db.on(`${sourceName}.afterUpdateWithAssociations`, async (_record, options) => {
        const transaction: Transaction = options.transaction;
        const executions = await workflow.getExecutions({ transaction });
        late.push({
          transaction,
          source: await rows(sourceName, transaction),
          target: await rows(targetName, transaction),
          executionStatuses: executions.map((execution) => execution.status),
        });
        transaction.afterCommit(() => {
          committed++;
        });
        if (reject) throw new Error('Source update rejected after workflow output');
      });
      const update = () =>
        agent()
          .resource(sourceName)
          .update({ filterByTk: 1, values: { amount: 140 } });
      const failed = await update();
      expect(failed.status).toBe(500);
      expect(failed.body.errors[0].message).toContain('Source update rejected after workflow output');
      await waitForWorkflowIdle(app);
      const sourceRows = [{ id: 1, name: 'Edited input', amount: 140, tenantId: 'B' }];
      const targetRows = [{ id: 1, name: 'Edited input', amount: 140, tenantId: 'B' }];
      expect(late).toHaveLength(1);
      expect(late[0].source).toEqual(sourceRows);
      expect(late[0].target).toEqual(targetRows);
      expect(late[0].executionStatuses).toEqual([EXECUTION_STATUS.RESOLVED]);
      expect(late[0].transaction.finished).toBe('rollback');
      expect(committed).toBe(0);
      expect(await rows(sourceName)).toEqual(unchanged);
      expect(await rows(targetName)).toEqual([]);
      expect(await workflow.getExecutions()).toEqual([]);

      reject = false;
      const accepted = await update();
      expect(accepted.status).toBe(200);
      expect(accepted.body.data).toEqual({ keys: [1], affected: 1 });
      await waitForWorkflowIdle(app);
      expect(late).toHaveLength(2);
      expect(late[1].source).toEqual(sourceRows);
      expect(late[1].target).toEqual(targetRows);
      expect(late[1].executionStatuses).toEqual([EXECUTION_STATUS.RESOLVED]);
      expect(late[1].transaction).not.toBe(late[0].transaction);
      expect(late[1].transaction.finished).toBe('commit');
      expect(committed).toBe(1);
      const noop = await update();
      expect(noop.status).toBe(200);
      expect(noop.body.data).toEqual({ keys: [], affected: 0 });
      await waitForWorkflowIdle(app);
      expect(late).toHaveLength(2);
      expect(committed).toBe(1);
      for (const [name, expected] of [
        [sourceName, sourceRows],
        [targetName, targetRows],
      ] as const) {
        expect(await rows(name)).toEqual(expected);
        const list = await agent()
          .resource(name)
          .list({ sort: ['id'] });
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual(expected);
      }
      const executions = await workflow.getExecutions();
      expect(executions).toHaveLength(1);
      const execution = executions[0];
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
      expect(execution.tenantId).toBe('B');
      expect(execution.tenantContext.currentTenantId).toBe('B');
      expect(execution.context.data).toEqual(sourceRows[0]);
      const jobs = await execution.getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].nodeId).toBe(create.id);
      expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
      expect(jobs[0].result).toEqual(targetRows[0]);
      expect(observed).toHaveLength(2);
      for (const [index, item] of observed.entries()) {
        expect(item.state).toEqual({ currentTenantId: 'B', currentUserId: user.id, currentRole: role });
        expect(item.transaction).toBe(late[index].transaction);
      }
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
