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
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated resource-event source action permission', () => {
  // A denied source action must not trigger a permitted downstream business write.
  // 来源动作被拒绝时，不得提前执行另一个有权限的业务写入。
  it.each([false, true])(
    'respects source action permission and runs the workflow (selected source: %s)',
    async (selectedSource) => {
      let app: MockServer;
      let unregister: (() => void) | undefined;
      let runtime: AccessMainWorkflowWriteRuntime;
      let source: AccessCollectionIdentity;
      let plugin: WorkflowPlugin;
      const selected: AccessCollectionIdentity[] = [];
      const observed: object[] = [];
      const role = 'resource-event-member';
      const creatorRole = 'resource-event-creator';
      const sourceName = 'resourceEventInputs';
      const password = 'resource-event-password';
      const collectionName = 'resourceEventTasks';
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
        for (const name of [role, creatorRole])
          await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
        const user = await app.db.getRepository('users').create({
          values: { username: role, password, roles: [role, creatorRole], tenants: ['B'], defaultTenantId: 'B' },
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
        source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
        selected.push(source);
        const sourceStored = await app.db.getRepository('collections').create({
          context: {},
          values: {
            name: sourceName,
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
        for (const roleName of [role, creatorRole]) {
          for (const name of [sourceName, collectionName]) {
            const canCreate = name === collectionName || roleName === creatorRole;
            const resource = await app.db.getRepository('dataSourcesRolesResources').create({
              values: {
                dataSourceKey: 'main',
                roleName,
                name,
                usingActionsConfig: true,
                actions: [
                  { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
                  ...(canCreate ? [{ name: 'create', fields: ['name', 'amount'] }] : []),
                ],
              },
            });
            const actions = await app.db
              .getRepository('dataSourcesRolesResources.actions', resource.get('id'))
              .find({});
            expect(
              actions
                .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            ).toEqual([
              ...(canCreate ? [{ name: 'create', fields: ['amount', 'name'] }] : []),
              { name: 'list', fields: ['amount', 'id', 'name', 'tenantId'] },
            ]);
          }
        }
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
                  right: { type: 'literal', value: String(user.id) },
                },
                {
                  type: 'any',
                  children: [role, creatorRole].map((name) => ({
                    type: 'compare',
                    operator: 'eq',
                    left: { type: 'context', path: 'role.name' },
                    right: { type: 'literal', value: name },
                  })),
                },
              ],
            }),
            revision: 0,
          },
          { userId: user.id },
        );
        if (selectedSource) {
          const sourceIdentity = {
            dataSourceKey: 'main',
            collectionKey: sourceStored.get('key'),
            collectionName: sourceName,
          };
          await runtime.registry.store.save(
            sourceIdentity,
            { ...configFor(ownerCondition), revision: 0 },
            { userId: user.id },
          );
          selected.push(sourceIdentity);
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
        await app.db.getRepository('collections').create({
          context: {},
          values: { name: 'resourceEventSignals', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
        });
        const workflow = await app.db.getRepository('workflows').create({
          values: {
            title: 'Before resource target create',
            type: 'collection',
            enabled: true,
            sync: true,
            config: { collection: 'resourceEventSignals', mode: 1 },
          },
        });
        const create = await workflow.createNode({
          type: 'create',
          config: {
            collection: collectionName,
            params: { values: { name: '{{$context.data.name}}', amount: '{{$context.data.amount}}' } },
          },
        });
        const event = await app.db.getRepository('webhooks').create({
          values: {
            name: 'Before resource intake',
            type: 'beforeResource',
            enabled: true,
            workflowKey: workflow.key,
            code: 'ctx.body = ctx.action.params.values;',
            options: {
              resourceName: sourceName,
              actionName: 'create',
              sort: 0,
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
            resourceName: sourceName,
            actionName: 'create',
            sort: 0,
            executionMode: 'inline',
            failurePolicy: 'block',
          },
        });
        // Install the original resource middleware without its background queue.
        // 安装原资源事件中间件，不安装后台队列。
        const trigger = new ResourceEventTrigger(app);
        trigger.load(persisted);
        trigger.afterAllLoad();
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
          app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', roleName);
        const check = await agent().get('/auth:check');
        expect(check.status).toBe(200);
        expect(check.body.data.id).toBe(user.id);
        const model = app.db.getCollection(collectionName).model;
        const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
        expect(await rows()).toEqual([]);
        const baseline = await agent()
          .resource(collectionName)
          .create({ values: { name: 'HTTP baseline', amount: 120 } });
        expect(baseline.status).toBe(200);
        expect(baseline.body.data).toEqual({ keys: [1], affected: 1 });
        const baselineRows = [{ id: 1, name: 'HTTP baseline', amount: 120, tenantId: 'B' }];
        expect(await rows()).toEqual(baselineRows);
        const sourceRows = () => app.db.getCollection(sourceName).model.findAll({ raw: true, order: [['id', 'ASC']] });
        expect(await sourceRows()).toEqual([]);
        const denied = await agent()
          .resource(sourceName)
          .create({ values: { name: 'Denied source', amount: 140 } });
        expect(denied.status).toBe(403);
        await waitForWorkflowIdle(app);
        expect(await sourceRows()).toEqual([]);
        expect(await rows()).toEqual(baselineRows);
        expect(await workflow.getExecutions()).toEqual([]);
        expect(observed).toEqual([]);
        const accepted = await agent(creatorRole)
          .resource(sourceName)
          .create({
            values: { name: 'Accepted source', amount: 140 },
          });
        expect(accepted.status).toBe(200);
        await waitForWorkflowIdle(app);
        expect(await sourceRows()).toEqual([{ id: 1, name: 'Accepted source', amount: 140, tenantId: 'B' }]);
        const expectedRows = [...baselineRows, { id: 2, name: 'Accepted source', amount: 140, tenantId: 'B' }];
        expect(await rows()).toEqual(expectedRows);
        const list = await agent(creatorRole)
          .resource(collectionName)
          .list({ sort: ['id'] });
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual(expectedRows);
        const executions = await workflow.getExecutions();
        expect(executions).toHaveLength(1);
        expect(executions[0].authContext).toEqual({ currentUserId: user.id, currentRole: creatorRole });
        expect(executions[0].tenantId).toBe('B');
        expect(executions[0].tenantContext.currentTenantId).toBe('B');
        expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
        const jobs = await executions[0].getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(create.id);
        expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
        expect(observed).toEqual([{ currentTenantId: 'B', currentUserId: user.id, currentRole: creatorRole }]);
      } finally {
        if (app) await waitForWorkflowIdle(app);
        unregister?.();
        await app?.destroy();
      }
    },
  );
});
