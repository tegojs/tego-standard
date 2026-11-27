import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

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

describe.skipIf(!coreEntry)('authenticated workflow business deletion', () => {
  // Visibility cannot authorize deletion, and a late hook failure must roll back every earlier deletion.
  // 可见性不能授权删除；后行钩子失败必须回滚前面已经执行的删除。
  it('deletes only G-matching rows and rolls back a failed batch through the real HTTP workflow', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let identity: AccessCollectionIdentity;
    let plugin: WorkflowPlugin;
    const observed: object[] = [];
    const creatorRole = 'deletion-creator';
    const operatorRole = 'deletion-operator';
    const password = 'deletion-password';
    const collectionName = 'workflowDeletionTasks';
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
              destroyResolver: (request) => {
                const authority = plugin.captureDataOperationAuthority(request);
                observed.push({
                  action: authority.actionName,
                  nodeId: authority.nodeId,
                  executionId: authority.executionId,
                  state: { ...authority.identityContext.state },
                });
                return runtime.resolveDestroy(request, [identity]);
              },
              destroyTransactionPlanner: (target) => runtime.plan(target, [identity]),
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
          username: 'deletion-member',
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
        values: { name: 'deletionEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Delete eligible business tasks',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'deletionEvents', mode: 1 },
        },
      });
      const node = await workflow.createNode({
        type: 'destroy',
        config: {
          collection: collectionName,
          params: {
            filter: { amount: { $gte: '{{$context.data.minimum}}' } },
            individualHooks: true,
          },
        },
      });
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Deletion intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'deletionIntake',
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
          resourceName: 'deletionIntake',
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
        .send({ account: 'deletion-member', password });
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
      const rows = (transaction?: Transaction) => model.findAll({ raw: true, order: [['id', 'ASC']], transaction });
      expect(await rows()).toEqual([]);
      const initial = [
        { id: 1, name: 'First eligible B', amount: 120, tenantId: 'B' },
        { id: 2, name: 'Second eligible B', amount: 140, tenantId: 'B' },
        { id: 3, name: 'Visible low B', amount: 5, tenantId: 'B' },
        { id: 4, name: 'Visible other C', amount: 160, tenantId: 'C' },
      ];
      for (const row of initial) {
        const created = await agent(creatorRole, row.tenantId)
          .resource(collectionName)
          .create({ values: { name: row.name, amount: row.amount } });
        expect(created.status).toBe(200);
        expect(created.body.data).toEqual({ keys: [row.id], affected: 1 });
      }
      expect(await rows()).toEqual(initial);
      const listed = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual(initial);
      const direct = await agent().resource(collectionName).destroy({ filterByTk: 1 });
      expect(direct.status).toBe(403);
      expect(await rows()).toEqual(initial);
      expect(await workflow.countExecutions()).toBe(0);
      let failDeletion = false;
      let insideFailedTransaction: unknown;
      app.db.on(`${collectionName}.afterDestroy`, async (record, options) => {
        if (failDeletion && record.get('id') === 2) {
          insideFailedTransaction = await rows(options.transaction);
          throw new Error('Business deletion rejected after the second row');
        }
      });
      const submit = async (minimum: number) => {
        const response = await agent().resource('deletionIntake').submit({ values: { minimum } });
        await waitForWorkflowIdle(app);
        return response;
      };
      const empty = await submit(150);
      expect([200, 204]).toContain(empty.status);
      expect(await rows()).toEqual(initial);
      failDeletion = true;
      const failed = await submit(0);
      expect(failed.status).toBe(500);
      expect(insideFailedTransaction).toEqual([initial[2], initial[3]]);
      expect(await rows()).toEqual(initial);
      failDeletion = false;
      const deleted = await submit(0);
      expect([200, 204]).toContain(deleted.status);
      const remaining = [initial[2], initial[3]];
      expect(await rows()).toEqual(remaining);
      const finalList = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(finalList.status).toBe(200);
      expect(finalList.body.data).toEqual(remaining);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(3);
      expect(executions.map((execution) => execution.status)).toEqual([
        EXECUTION_STATUS.RESOLVED,
        EXECUTION_STATUS.ERROR,
        EXECUTION_STATUS.RESOLVED,
      ]);
      for (const [index, execution] of executions.entries()) {
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: operatorRole });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.context.data).toEqual({ minimum: index === 0 ? 150 : 0 });
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(node.id);
        expect(jobs[0].status).toBe(index === 1 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
        if (index === 1) {
          expect(jobs[0].result).toMatchObject({ message: 'Business deletion rejected after the second row' });
        } else {
          expect(jobs[0].result).toBe(index === 0 ? 0 : 2);
        }
      }
      expect(observed).toEqual(
        executions.map((execution) => ({
          action: 'destroy',
          nodeId: node.id,
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
