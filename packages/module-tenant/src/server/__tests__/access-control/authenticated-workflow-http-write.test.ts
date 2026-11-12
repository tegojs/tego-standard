import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated workflow HTTP business writes', () => {
  // Minting a token must not bypass the destination ACL/G or lose the real actor.
  // 节点签发新token后不能绕过目标ACL/G或丢失真实用户身份。
  it('re-enters ordinary HTTP authorization with the real user and explicit role and tenant headers', async () => {
    let app: MockServer;
    let server: Server;
    let unregister: (() => void) | undefined;
    const role = 'http-task-editor';
    const deniedRole = 'http-task-without-actions';
    const password = 'http-task-password';
    const collectionName = 'httpWorkflowTasks';
    const observed: object[] = [];
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [WorkflowPlugin, { name: 'workflow', packageName: '@tachybase/module-workflow', workspaceSource: true }],
        ],
      });
      app.db.registerModels({ EventSourceModel, WebhookCategories });
      app.db.collection(webhooksCollection);
      app.db.collection(webhookCategoriesCollection);
      await app.db.sync();
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [role, deniedRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
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
      const source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
            { name: 'create', fields: ['name'] },
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
      ]);
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
                operator: 'ne',
                left: { type: 'field', path: 'name' },
                right: { type: 'literal', value: 'Excluded task' },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(user.id) },
              },
              {
                type: 'any',
                children: [role, deniedRole].map((name) => ({
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
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => {
        if (ctx.action.resourceName === collectionName && ctx.action.actionName === 'create')
          observed.push({
            userId: ctx.state.currentUser?.id,
            role: ctx.state.currentRole,
            tenantId: ctx.state.currentTenantId,
          });
        return registry.select(ctx, adapter, [source.collectionKey]);
      });
      server = createServer(app.callback());
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = (server.address() as AddressInfo).port;
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'httpWorkflowEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'HTTP task intake',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'httpWorkflowEvents', mode: 1 },
        },
      });
      const request = await workflow.createNode({
        type: 'request',
        config: {
          url: `http://127.0.0.1:${port}${app.resourcer.options.prefix || ''}/${collectionName}:create`,
          method: 'POST',
          needAuthorization: true,
          timeout: 5000,
          params: [],
          headers: [
            { name: 'X-Authenticator', value: 'basic' },
            { name: 'X-Role', value: '{{$context.roleName}}' },
            { name: 'X-Tenant-ID', value: 'B' },
          ],
          data: { name: '{{$context.data.name}}' },
        },
      });
      const event = await app.db.getRepository('webhooks').create({
        values: {
          name: 'HTTP task intake',
          type: 'resource',
          enabled: true,
          workflowKey: workflow.key,
          code: 'ctx.body = ctx.action.params.values;',
          options: {
            resourceName: 'httpWorkflowIntake',
            actionName: 'submit',
            executionMode: 'inline',
            failurePolicy: 'block',
          },
        },
      });
      const persisted = await app.db.getRepository('webhooks').findOne({ filterByTk: event.id });
      expect(persisted).toBeInstanceOf(EventSourceModel);
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
      const agent = (roleName = role) =>
        app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', roleName);
      const check = await agent().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const deniedAction = await agent(deniedRole)
        .resource('httpWorkflowIntake')
        .submit({ values: { name: 'Approved task' } });
      expect(deniedAction.status).toBe(500);
      await waitForWorkflowIdle(app);
      expect(await rows()).toEqual([]);
      const deniedG = await agent()
        .resource('httpWorkflowIntake')
        .submit({ values: { name: 'Excluded task' } });
      expect(deniedG.status).toBe(500);
      await waitForWorkflowIdle(app);
      expect(await rows()).toEqual([]);
      const accepted = await agent()
        .resource('httpWorkflowIntake')
        .submit({ values: { name: 'Approved task' } });
      expect([200, 204]).toContain(accepted.status);
      await waitForWorkflowIdle(app);
      const expected = [{ id: 1, name: 'Approved task', tenantId: 'B' }];
      expect(await rows()).toEqual(expected);
      const list = await agent()
        .resource(collectionName)
        .list({ sort: ['id'] });
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual(expected);
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions).toHaveLength(3);
      for (const [index, execution] of executions.entries()) {
        expect(execution.authContext).toEqual({ currentUserId: user.id, currentRole: index === 0 ? deniedRole : role });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        expect(execution.status).toBe(index === 2 ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.FAILED);
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].nodeId).toBe(request.id);
        expect(jobs[0].status).toBe(index === 2 ? JOB_STATUS.RESOLVED : JOB_STATUS.FAILED);
        if (index === 2) expect(jobs[0].result.data).toEqual({ keys: [1], affected: 1 });
        else expect(jobs[0].result.error.status).toBe(403);
      }
      expect(observed).toEqual([
        { userId: user.id, role: deniedRole, tenantId: 'B' },
        { userId: user.id, role, tenantId: 'B' },
        { userId: user.id, role, tenantId: 'B' },
      ]);
    } finally {
      if (app) await waitForWorkflowIdle(app);
      if (server)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      unregister?.();
      await app?.destroy();
    }
  });
});
