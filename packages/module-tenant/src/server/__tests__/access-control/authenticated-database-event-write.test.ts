import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import webhookCategoriesCollection from '../../../../../module-event-source/src/server/collections/webhookCategories';
import webhooksCollection from '../../../../../module-event-source/src/server/collections/webhooks';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { WebhookCategories } from '../../../../../module-event-source/src/server/model/WebhookCategories';
import { DatabaseEventTrigger } from '../../../../../module-event-source/src/server/trigger/DatabaseEventTrigger';
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

describe.skipIf(!coreEntry)('authenticated database-event business writes', () => {
  // Losing hook identity or its caller transaction must break the persisted two-table outcome.
  // 丢失数据库事件身份或调用方事务时，两张业务表的持久结果必须让测试失败。
  it('rolls back the source create when its database-event workflow cannot create the target', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let plugin: WorkflowPlugin;
    const selected: AccessCollectionIdentity[] = [];
    const observed: { state: object; transaction: Transaction }[] = [];
    const sourceTransactions: Transaction[] = [];
    const role = 'database-event-member';
    const password = 'database-event-password';
    const sourceName = 'databaseEventInputs';
    const targetName = 'databaseEventTasks';
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
      app.db.registerModels({ EventSourceModel, WebhookCategories });
      app.db.collection(webhooksCollection);
      app.db.collection(webhookCategoriesCollection);
      await app.db.sync();
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
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
              { name: 'create', fields: ['name', 'amount'] },
            ],
          },
        });
        const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        expect(
          actions
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          { name: 'create', fields: ['amount', 'name'] },
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
                  operator: 'gte',
                  left: { type: 'field', path: 'amount' },
                  right: { type: 'literal', value: collectionName === targetName ? 100 : 0 },
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
      const agent = () =>
        app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', role);
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const rows = (name: string) =>
        app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']], transaction: null });
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(targetName)).toEqual([]);
      const baseline = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Before listener', amount: 120 } });
      expect(baseline.status).toBe(200);
      expect(baseline.body.data).toEqual({ keys: [1], affected: 1 });
      const baselineRows = [{ id: 1, name: 'Before listener', amount: 120, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(baselineRows);
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'databaseEventSignals', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Database event target create',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'databaseEventSignals', mode: 1 },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        config: {
          collection: targetName,
          params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
        },
      });
      const eventName = `${sourceName}.afterCreateWithAssociations`;
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Database event intake',
          type: 'database',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.model.toJSON();',
          options: { eventName },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect({ code: persisted.code, workflowKey: persisted.workflowKey, options: persisted.options }).toEqual({
        code: 'ctx.body = ctx.model.toJSON();',
        workflowKey: workflow.key,
        options: { eventName },
      });
      app.db.on(eventName, (_record, options) => {
        sourceTransactions.push(options.transaction);
      });
      new DatabaseEventTrigger(app).load(persisted);
      const denied = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Excluded target', amount: 80 } });
      expect(denied.status).toBe(500);
      expect(denied.body.errors[0].message).toMatch(/Record is unavailable/);
      await waitForWorkflowIdle(app);
      expect(await rows(sourceName)).toEqual(baselineRows);
      expect(await rows(targetName)).toEqual([]);
      expect(await workflow.getExecutions()).toEqual([]);
      const accepted = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Accepted target', amount: 140 } });
      expect(accepted.status).toBe(200);
      expect(accepted.body.data).toEqual({ keys: [2], affected: 1 });
      await waitForWorkflowIdle(app);
      const sourceRows = [...baselineRows, { id: 2, name: 'Accepted target', amount: 140, tenantId: 'B' }];
      const targetRows = [{ id: 1, name: 'Accepted target', amount: 140, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(sourceRows);
      expect(await rows(targetName)).toEqual(targetRows);
      for (const [name, expected] of [
        [sourceName, sourceRows],
        [targetName, targetRows],
      ] as const) {
        const list = await agent()
          .resource(name)
          .list({ sort: ['id'] });
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual(expected);
      }
      const executions = await workflow.getExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0].authContext).toEqual({ currentUserId: user.id, currentRole: role });
      expect(executions[0].tenantId).toBe('B');
      expect(executions[0].tenantContext.currentTenantId).toBe('B');
      expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      const jobs = await executions[0].getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].nodeId).toBe(create.id);
      expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
      expect(observed).toHaveLength(2);
      expect(sourceTransactions).toHaveLength(2);
      for (const [index, item] of observed.entries()) {
        expect(item.state).toEqual({ currentTenantId: 'B', currentUserId: user.id, currentRole: role });
        expect(item.transaction).toBe(sourceTransactions[index]);
        expect(item.transaction.finished).toBe(index === 0 ? 'rollback' : 'commit');
      }
      expect(sourceTransactions[1]).not.toBe(sourceTransactions[0]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
