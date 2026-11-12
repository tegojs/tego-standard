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

describe.skipIf(!coreEntry)('authenticated manual resume business writes', () => {
  // A human decision resumes the execution; it does not replace its business actor or tenant.
  // 人工确认恢复原执行，不能替换后续业务写入的执行身份或租户。
  it('keeps the initiating actor and tenant when another assignee submits a custom form', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let plugin: WorkflowPlugin;
    let runtime: AccessMainWorkflowWriteRuntime;
    let source: AccessCollectionIdentity;
    const observed: object[] = [];
    const initiatorRole = 'manual-resume-initiator';
    const assigneeRole = 'manual-resume-assignee';
    const collectionName = 'manualResumeBusinessTasks';
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
              manualFormGuard: (request) => runtime.assertManualFormBoundary(request, [source]),
            },
          ],
        ],
      });
      plugin = app.pm.get('workflow') as WorkflowPlugin;
      runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'B', name: 'B', enabled: true },
          { id: 'C', name: 'C', enabled: true },
        ],
      });
      const password = 'manual-resume-password';
      const users = [];
      for (const role of [initiatorRole, assigneeRole]) {
        await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
        users.push(
          await app.db.getRepository('users').create({
            values: { username: role, password, roles: [role], tenants: ['B', 'C'], defaultTenantId: 'B' },
          }),
        );
      }
      const [initiator, assignee] = users;
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
      for (const role of [initiatorRole, assigneeRole]) {
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName: role,
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
                right: { type: 'literal', value: String(initiator.id) },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: initiatorRole },
              },
            ],
          }),
          revision: 0,
        },
        { userId: initiator.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', runtime.registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        runtime.registry.select(ctx, adapter, [source.collectionKey]),
      );
      await app.db.getRepository('collections').create({
        context: {},
        values: { name: 'manualResumeEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      });
      const workflow = await app.db.getRepository('workflows').create({
        values: {
          title: 'Manual decision followed by business create',
          type: 'collection',
          enabled: true,
          sync: true,
          config: { collection: 'manualResumeEvents', mode: 1 },
        },
      });
      const manual = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [assignee.id],
          forms: { form: { type: 'custom', actions: [{ key: 'confirm', status: JOB_STATUS.RESOLVED }] } },
        },
      });
      const create = await workflow.createNode({
        type: 'create',
        upstreamId: manual.id,
        config: {
          collection: collectionName,
          params: {
            values: {
              name: `{{$jobsMapByNodeKey.${manual.key}.form.name}}`,
              amount: `{{$jobsMapByNodeKey.${manual.key}.form.amount}}`,
            },
          },
        },
      });
      await manual.setDownstream(create);
      const tokens: string[] = [];
      for (const user of users) {
        const login = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
          account: user.username,
          password,
        });
        expect(login.status).toBe(200);
        expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
        expect(login.body.data.token).toEqual(expect.any(String));
        tokens.push(login.body.data.token);
      }
      const agent = (index: number) =>
        app
          .agent()
          .set('Authorization', `Bearer ${tokens[index]}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', index === 0 ? initiatorRole : assigneeRole)
          .set('X-Tenant-Id', index === 0 ? 'B' : 'C');
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      for (const [index, user] of users.entries()) {
        const check = await agent(index).get('/auth:check');
        expect(check.status).toBe(200);
        expect(check.body.data).toMatchObject({ id: user.id, hasPassword: true });
        expect(
          (
            await agent(index)
              .resource(collectionName)
              .create({ values: { name: 'Manual denied', amount: 140 } })
          ).status,
        ).toBe(403);
      }
      expect(await rows()).toEqual([]);
      const expectedRows = [{ id: 1, name: 'Accepted manual decision', amount: 140, tenantId: 'B' }];
      for (const [index, values] of [
        { name: 'Excluded manual decision', amount: 80 },
        { name: 'Accepted manual decision', amount: 140 },
      ].entries()) {
        const trigger = await agent(0)
          .resource('workflows')
          .trigger({
            filterByTk: workflow.id,
            updateData: encodeURIComponent('{}'),
          });
        expect([200, 204]).toContain(trigger.status);
        await vi.waitFor(async () => {
          const current = await workflow.getExecutions({ order: [['id', 'ASC']] });
          expect(current).toHaveLength(index + 1);
          expect(current[index].status).toBe(EXECUTION_STATUS.STARTED);
          expect(await app.db.getRepository('users_jobs').count({ filter: { executionId: current[index].id } })).toBe(
            1,
          );
        });
        await waitForWorkflowIdle(app);
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions).toHaveLength(index + 1);
        const execution = executions[index];
        expect(execution.status).toBe(EXECUTION_STATUS.STARTED);
        const pending = await app.db.getRepository('users_jobs').findOne({ filter: { executionId: execution.id } });
        expect(pending.toJSON()).toMatchObject({ userId: assignee.id, status: JOB_STATUS.PENDING, nodeId: manual.id });
        const pendingBefore = pending.toJSON();
        const executionBefore = execution.toJSON();
        const jobsBefore = (await execution.getJobs()).map((job) => job.toJSON());
        expect(jobsBefore).toHaveLength(1);
        expect(jobsBefore[0]).toMatchObject({ nodeId: manual.id, status: JOB_STATUS.PENDING, result: null });
        expect(observed).toHaveLength(index);
        const submit = (actor: number) =>
          agent(actor)
            .resource('users_jobs')
            .submit({
              filterByTk: pending.id,
              values: { result: { form: values, _: 'confirm' } },
            });
        expect((await submit(0)).status).toBe(403);
        await pending.reload();
        await execution.reload();
        expect(pending.toJSON()).toEqual(pendingBefore);
        expect(execution.toJSON()).toEqual(executionBefore);
        expect((await execution.getJobs()).map((job) => job.toJSON())).toEqual(jobsBefore);
        expect(await rows()).toEqual([]);
        const response = await submit(1);
        expect(response.status).toBe(202);
        expect(response.body.data).toMatchObject({
          id: pending.id,
          status: JOB_STATUS.RESOLVED,
          result: { form: values, _: 'confirm' },
        });
        await vi.waitFor(async () => {
          await execution.reload();
          expect(execution.status).toBe(index === 0 ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
        });
        await waitForWorkflowIdle(app);
        await pending.reload();
        expect(pending.status).toBe(JOB_STATUS.RESOLVED);
        expect(pending.result).toEqual({ form: values, _: 'confirm' });
        expect(execution.authContext).toEqual({ currentUserId: initiator.id, currentRole: initiatorRole });
        expect(execution.tenantId).toBe('B');
        expect(execution.tenantContext.currentTenantId).toBe('B');
        const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
        expect(jobs).toHaveLength(2);
        expect(jobs[0]).toMatchObject({
          nodeId: manual.id,
          status: JOB_STATUS.RESOLVED,
          result: { form: values, _: 'confirm' },
        });
        expect(jobs[1]).toMatchObject({
          nodeId: create.id,
          upstreamId: jobs[0].id,
          status: index === 0 ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED,
        });
        if (index === 0) expect(jobs[1].result.message).toMatch(/Record is unavailable/);
        else expect(jobs[1].result).toEqual(expectedRows[0]);
        expect(await rows()).toEqual(index === 0 ? [] : expectedRows);
      }
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(observed).toEqual(
        executions.map((execution) => ({
          action: 'create',
          nodeId: create.id,
          executionId: execution.id,
          state: { currentTenantId: 'B', currentUserId: initiator.id, currentRole: initiatorRole },
        })),
      );
      for (const index of [0, 1]) {
        const list = await agent(index).resource(collectionName).list({});
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual(index === 0 ? expectedRows : []);
      }
    } finally {
      if (app) await waitForWorkflowIdle(app);
      unregister?.();
      await app?.destroy();
    }
  });
});
