import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe.skipIf(!coreEntry)('authenticated asynchronous collection commit boundary', () => {
  // A rolled-back source create must not become a successful asynchronous business output.
  // 来源新增回滚后，不得留下成功的异步业务输出。
  it('publishes only committed source creates with their authenticated user and tenant', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let boundary: AccessMainWorkflowCollectionReadBoundary;
    let plugin: WorkflowPlugin;
    const selected: AccessCollectionIdentity[] = [];
    const observed: { state: object; transaction: Transaction }[] = [];
    const sourceTransactions: { transaction: Transaction; rows: unknown }[] = [];
    const role = 'collection-async-editor';
    const deniedRole = 'collection-async-without-actions';
    const password = 'collection-async-password';
    const sourceName = 'collectionAsyncInputs';
    const targetName = 'collectionAsyncOutputs';
    // File-backed SQLite gives the original queue its own connection, not a fabricated worker.
    const storage = join(mkdtempSync(join(tmpdir(), 'tego-collection-async-')), 'database.sqlite');
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage },
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
              ...(collectionName === sourceName ? [{ name: 'create', fields: ['name', 'amount'] }] : []),
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
      const idle = async () => {
        await waitForWorkflowIdle(app);
        // Preparation may have shifted the event before it has published an execution.
        await plugin['preparing'];
        await waitForWorkflowIdle(app);
      };
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(targetName)).toEqual([]);
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Publish a committed source',
          type: 'collection',
          enabled: true,
          sync: false,
          config: { collection: sourceName, mode: 1 },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        config: {
          collection: targetName,
          params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
        },
      });
      let committed = 0;
      app.db.on(`${sourceName}.afterCreateWithAssociations`, async (record, options) => {
        const transaction: Transaction = options.transaction;
        sourceTransactions.push({ transaction, rows: await rows(sourceName, transaction) });
        transaction.afterCommit(() => {
          committed++;
        });
        if (record.get('name') === 'Rejected input') throw new Error('Reject source after asynchronous event hook');
      });
      const input = (name: string, amount: number, roleName = role) =>
        agent(roleName).resource(sourceName).create({ values: { name, amount } });
      const denied = await input('Denied input', 120, deniedRole);
      expect(denied.status).toBe(403);
      const deniedTarget = await agent()
        .resource(targetName)
        .create({ values: { name: 'Manual output', amount: 120 } });
      expect(deniedTarget.status).toBe(403);
      await idle();
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(targetName)).toEqual([]);
      expect(await workflow.getExecutions()).toEqual([]);
      expect(sourceTransactions).toEqual([]);

      const initial = [{ id: 1, name: 'Committed input', amount: 120, tenantId: 'B' }];
      const accepted = await input('Committed input', 120);
      expect(accepted.status).toBe(200);
      expect(accepted.body.data).toEqual({ keys: [1], affected: 1 });
      await idle();
      expect(await rows(sourceName)).toEqual(initial);
      expect(await rows(targetName)).toEqual(initial);
      expect((await workflow.getExecutions()).map((execution) => execution.status)).toEqual([
        EXECUTION_STATUS.RESOLVED,
      ]);
      expect(sourceTransactions[0].rows).toEqual(initial);
      expect(sourceTransactions[0].transaction.finished).toBe('commit');
      expect(committed).toBe(1);

      const rejected = await input('Rejected input', 130);
      expect(rejected.status).toBe(500);
      expect(rejected.body.errors[0].message).toContain('Reject source after asynchronous event hook');
      await idle();
      expect(sourceTransactions).toHaveLength(2);
      expect(sourceTransactions[1].rows).toEqual([
        ...initial,
        { id: 2, name: 'Rejected input', amount: 130, tenantId: 'B' },
      ]);
      expect(sourceTransactions[1].transaction.finished).toBe('rollback');
      expect(await rows(sourceName)).toEqual(initial);
      expect(await rows(targetName)).toEqual(initial);
      expect(await workflow.getExecutions()).toHaveLength(1);
      expect(committed).toBe(1);
      expect(observed).toHaveLength(1);

      const recovered = await input('Recovered input', 140);
      expect(recovered.status).toBe(200);
      expect(recovered.body.data).toEqual({ keys: [2], affected: 1 });
      await idle();
      const final = [...initial, { id: 2, name: 'Recovered input', amount: 140, tenantId: 'B' }];
      for (const name of [sourceName, targetName]) {
        expect(await rows(name)).toEqual(final);
        const list = await agent()
          .resource(name)
          .list({ sort: ['id'] });
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual(final);
      }
      expect(committed).toBe(2);
      expect(sourceTransactions).toHaveLength(3);
      expect(sourceTransactions[2].transaction.finished).toBe('commit');
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(2);
      for (const [index, execution] of executions.entries()) {
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.context.data).toEqual(final[index]);
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(create.id);
        expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
        expect(jobs[0].result).toEqual(final[index]);
      }
      expect(observed).toHaveLength(2);
      for (const item of observed) {
        expect(item.state).toEqual({ currentTenantId: 'B', currentUserId: user.id, currentRole: role });
        expect(sourceTransactions.some((source) => source.transaction === item.transaction)).toBe(false);
      }
    } finally {
      if (app) {
        await waitForWorkflowIdle(app);
        await plugin?.['preparing'];
        await waitForWorkflowIdle(app);
      }
      unregister?.();
      await app?.destroy();
    }
  });
});
