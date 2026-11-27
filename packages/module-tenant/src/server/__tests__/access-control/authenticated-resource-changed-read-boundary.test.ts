import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import webhookCategoriesCollection from '../../../../../module-event-source/src/server/collections/webhookCategories';
import webhooksCollection from '../../../../../module-event-source/src/server/collections/webhooks';
import { EventSourceModel } from '../../../../../module-event-source/src/server/model/EventSourceModel';
import { WebhookCategories } from '../../../../../module-event-source/src/server/model/WebhookCategories';
import { ResourceEventTrigger } from '../../../../../module-event-source/src/server/trigger/ResourceEventTrigger';
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

describe.skipIf(!coreEntry)('authenticated resource-event getChanged read boundary', () => {
  // A rejected update must not copy the selected record through a raw before-event read.
  // 被拒绝的修改不能通过前置事件的原始读取复制选中记录。
  it('refuses selected getChanged reads before copying old business values to another table', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let runtime: AccessMainWorkflowWriteRuntime;
    let plugin: WorkflowPlugin;
    let sourceIdentity: AccessCollectionIdentity;
    const selected: AccessCollectionIdentity[] = [];
    const observed: object[] = [];
    let guardMode: 'normal' | 'async' | 'invalid' | 'throw' | 'second' = 'normal';
    let guardCalls = 0;
    const role = 'changed-read-member';
    const password = 'changed-read-password';
    const sourceName = 'changedReadInputs';
    const targetName = 'changedReadCopies';
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
                observed.push({ ...authority.identityContext.state });
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
        if (collectionName === sourceName) sourceIdentity = identity;
        else selected.push(identity);
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName: role,
            name: collectionName,
            usingActionsConfig: true,
            actions: [
              { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
              { name: 'create', fields: ['name', 'amount'] },
              ...(collectionName === sourceName ? [{ name: 'update', fields: ['name', 'amount'] }] : []),
            ],
          },
        });
        const actions = await resource.getActions();
        expect(
          actions
            .map((action) => ({
              name: action.get('name'),
              fields: [...action.get('fields')].sort(),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual([
          { name: 'create', fields: ['amount', 'name'] },
          { name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] },
          ...(collectionName === sourceName ? [{ name: 'update', fields: ['amount', 'name'] }] : []),
        ]);
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
        await runtime.registry.store.save(
          identity,
          {
            ...config,
            revision: 0,
            rules: collectionName === sourceName ? [] : config.rules,
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
        app.db.getCollection(name).model.findAll({
          raw: true,
          order: [['id', 'ASC']],
          transaction: null,
        });
      let sourceReads = 0;
      app.db.getCollection(sourceName).model.addHook('beforeFind', (options) => {
        // The native tenant precheck supplies context; getChanged's two queries do not.
        // 原租户前置检查带 context；getChanged 的两次查询不带该参数。
        if (!options.context) sourceReads += 1;
      });
      expect(await rows(sourceName)).toEqual([]);
      expect(await rows(targetName)).toEqual([]);
      const created = await agent()
        .resource(sourceName)
        .create({ values: { name: 'Known draft', amount: 120 } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ id: 1, name: 'Known draft', amount: 120, tenantId: 'B' });
      expect(
        (
          await agent()
            .resource(sourceName)
            .list({ sort: ['id'] })
        ).body.data,
      ).toEqual([{ id: 1, name: 'Known draft', amount: 120, tenantId: 'B' }]);
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'changedReadSignals', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Copy old resource values',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'changedReadSignals', mode: 1 },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        config: {
          collection: targetName,
          params: {
            values: {
              name: '{{$context.data.name}}',
              amount: '{{$context.data.amount}}',
            },
          },
        },
      });
      const code =
        "const result = await ctx.getChanged(); if (result.error) throw new Error('Old values unavailable'); ctx.body = result.data;";
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'Read old resource values',
          type: 'beforeResource',
          enabled: true,
          workflowKey: workflow.key,
          code,
          options: {
            resourceName: sourceName,
            actionName: 'update',
            sort: 0,
            executionMode: 'inline',
            failurePolicy: 'block',
          },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
      expect({ code: persisted.code, workflowKey: persisted.workflowKey, options: persisted.options }).toEqual({
        code,
        workflowKey: workflow.key,
        options: {
          resourceName: sourceName,
          actionName: 'update',
          sort: 0,
          executionMode: 'inline',
          failurePolicy: 'block',
        },
      });
      const boundary = new AccessMainWorkflowCollectionReadBoundary(app);
      expect(() => new ResourceEventTrigger(app, false, true as never)).toThrow(/must be a function/);
      const trigger = new ResourceEventTrigger(app, false, (request) => {
        guardCalls += 1;
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.params)).toBe(true);
        expect(request.params).toEqual({ filter: { id: '1' }, appends: [] });
        expect(request.collection).toBe(app.db.getCollection(sourceName));
        expect(request.context).toMatchObject({ state: { currentRole: role, currentTenantId: 'B' } });
        if (guardMode === 'async') return Promise.resolve() as never;
        if (guardMode === 'invalid') return false as never;
        if (guardMode === 'throw' || (guardMode === 'second' && guardCalls === 2)) {
          throw new Error('Resource old-value read refused');
        }
        return boundary.assert(request, selected);
      });
      trigger.load(persisted);
      trigger.afterAllLoad();
      const first = await agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Known edit' } });
      expect(first.status).toBe(200);
      await waitForWorkflowIdle(app);
      const sourceRows = [{ id: 1, name: 'Known edit', amount: 120, tenantId: 'B' }];
      const targetRows = [{ id: 1, name: 'Known draft', amount: 120, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(sourceRows);
      expect(await rows(targetName)).toEqual(targetRows);
      expect(guardCalls).toBe(2);
      const executions = await workflow.getExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0].authContext).toEqual({ currentUserId: user.id, currentRole: role });
      expect(executions[0].tenantId).toBe('B');
      expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      const jobs = await executions[0].getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].nodeId).toBe(create.id);
      expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
      selected.push(sourceIdentity);
      const hidden = await agent()
        .resource(sourceName)
        .list({ sort: ['id'] });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data).toEqual([]);
      const beforeDenied = sourceReads;
      const denied = await agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Should not save' } });
      await waitForWorkflowIdle(app);
      expect(sourceReads).toBe(beforeDenied);
      expect({
        status: denied.status,
        source: await rows(sourceName),
        copies: await rows(targetName),
        executions: (await workflow.getExecutions()).map((execution) => execution.id),
      }).toEqual({ status: 400, source: sourceRows, copies: targetRows, executions: [executions[0].id] });
      expect(denied.body.errors[0].message).toMatch(/dedicated adapter/);
      expect(observed).toEqual([{ currentTenantId: 'B', currentUserId: user.id, currentRole: role }]);
      selected.splice(selected.indexOf(sourceIdentity), 1);
      for (const mode of ['async', 'invalid', 'throw', 'second'] as const) {
        guardMode = mode;
        guardCalls = 0;
        const beforeFault = sourceReads;
        const refused = await agent()
          .resource(sourceName)
          .update({ filterByTk: 1, values: { name: 'Fault control' } });
        expect(refused.status).toBe(500);
        expect(refused.body.errors[0].message).toMatch(
          mode === 'throw' || mode === 'second' ? /old-value read refused/ : /undefined synchronously/,
        );
        expect(guardCalls).toBe(mode === 'second' ? 2 : 1);
        expect(sourceReads - beforeFault).toBe(mode === 'second' ? 1 : 0);
        expect(await rows(sourceName)).toEqual(sourceRows);
        expect(await rows(targetName)).toEqual(targetRows);
        expect((await workflow.getExecutions()).map((execution) => execution.id)).toEqual([executions[0].id]);
      }
      guardMode = 'normal';
      selected.push(sourceIdentity);
      const caughtCode =
        "try { const result = await ctx.getChanged(); ctx.body = result.data || { name: 'Fallback', amount: 140 }; } catch { ctx.body = { name: 'Fallback', amount: 140 }; }";
      await persisted.update({ code: caughtCode });
      trigger.afterUpdate(persisted);
      const caught = await agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Caught refusal' } });
      expect(caught.status).toBe(400);
      expect(caught.body.errors[0].message).toMatch(/dedicated adapter/);
      expect(await rows(sourceName)).toEqual(sourceRows);
      expect(await rows(targetName)).toEqual(targetRows);
      expect((await workflow.getExecutions()).map((execution) => execution.id)).toEqual([executions[0].id]);
      selected.splice(selected.indexOf(sourceIdentity), 1);
      await persisted.update({ code });
      trigger.afterUpdate(persisted);
      const restored = await agent()
        .resource(sourceName)
        .update({ filterByTk: 1, values: { name: 'Final edit' } });
      expect(restored.status).toBe(200);
      await waitForWorkflowIdle(app);
      const finalSource = [{ id: 1, name: 'Final edit', amount: 120, tenantId: 'B' }];
      const finalCopies = [...targetRows, { id: 2, name: 'Known edit', amount: 120, tenantId: 'B' }];
      expect(await rows(sourceName)).toEqual(finalSource);
      expect(await rows(targetName)).toEqual(finalCopies);
      for (const [name, expected] of [
        [sourceName, finalSource],
        [targetName, finalCopies],
      ] as const) {
        const listed = await agent()
          .resource(name)
          .list({ sort: ['id'] });
        expect(listed.status).toBe(200);
        expect(listed.body.data).toEqual(expected);
      }
      expect(await workflow.countExecutions()).toBe(2);
      expect(observed).toEqual([
        { currentTenantId: 'B', currentUserId: user.id, currentRole: role },
        { currentTenantId: 'B', currentUserId: user.id, currentRole: role },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
