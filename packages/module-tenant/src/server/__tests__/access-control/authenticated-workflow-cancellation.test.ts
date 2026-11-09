import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import DelayInstruction from '../../../../../module-workflow/src/server/features/delay/DelayInstruction';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated cancellation before a selected workflow write', () => {
  let app: MockServer;
  let delay: DelayInstruction;
  const outcomes: Promise<void>[] = [];

  afterEach(async () => {
    delay?.unload();
    await Promise.all(outcomes);
    if (app) await waitForWorkflowIdle(app);
    vi.restoreAllMocks();
    await app?.destroy();
    outcomes.length = 0;
  });

  // Losing cancellation state must permit the real due callback to create a row and fail this contract.
  // 若取消状态丢失，真实到期回调将新增业务行，必须使此契约失败。
  it.each([false, true])('preserves the persisted participant identity when cancelled=%s', async (cancelled) => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    let runtime: AccessMainWorkflowWriteRuntime;
    let source: AccessCollectionIdentity;
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          'workflow',
          {
            name: 'workflow',
            createResolver: (request) => runtime.resolveCreate(request, [source]),
            createTransactionPlanner: (target) => runtime.plan(target, [source]),
          },
        ],
      ],
    });
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
    delay = plugin.instructions.get('delay') as DelayInstruction;
    const original = delay.trigger.bind(delay);
    vi.spyOn(delay, 'trigger').mockImplementation((job) => {
      const result = original(job);
      outcomes.push(result);
      return result;
    });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const participantRole = 'delay-participant';
    const managerRole = 'delay-manager';
    const password = 'delay-cancellation-test-password';
    const identities = [];
    for (const [role, snippets] of [
      [participantRole, []],
      [managerRole, ['pm.workflow.workflows']],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(signedIn.status).toBe(200);
      expect(String(signedIn.body.data.user.id)).toBe(String(user.get('id')));
      expect(signedIn.body.data.user.hasPassword).toBe(true);
      expect(signedIn.body.data.token).toEqual(expect.any(String));
      identities.push({ role, userId: user.get('id'), token: signedIn.body.data.token });
    }
    const [participant, manager] = identities;
    const agent = (identity = participant) =>
      app
        .agent()
        .set('Authorization', `Bearer ${identity.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', identity.role)
        .set('X-Tenant-Id', 'B');
    for (const identity of identities) {
      const checked = await agent(identity).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(String(checked.body.data.id)).toBe(String(identity.userId));
    }
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'authenticatedDelayTasks',
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: stored.get('name') };
    await app.db.getRepository('collections').create({
      context: {},
      values: { name: 'authenticatedDelayEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
    });
    await app.db.collection(accessConfigHistory).model.sync();
    const config = configFor({
      type: 'all',
      children: [
        ownerCondition,
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'user.id' },
          right: { type: 'literal', value: String(participant.userId) },
        },
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'role.name' },
          right: { type: 'literal', value: participantRole },
        },
      ],
    });
    await runtime.registry.store.save(source, { ...config, revision: 0 }, { userId: participant.userId });
    const rows = () => app.db.getCollection(source.collectionName).model.findAll({ raw: true });
    expect(await rows()).toEqual([]);
    const direct = await agent()
      .resource(source.collectionName)
      .create({ values: { name: 'Denied direct write' } });
    expect(direct.status).toBe(403);
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Authenticated delayed create',
        type: 'collection',
        enabled: true,
        sync: false,
        config: { collection: 'authenticatedDelayEvents', mode: 1 },
      },
    });
    const wait = await workflow.createNode({
      type: 'delay',
      config: { duration: 5000, endStatus: JOB_STATUS.RESOLVED },
    });
    const create = await workflow.createNode({
      type: 'create',
      upstreamId: wait.id,
      config: { collection: source.collectionName, params: { values: { name: 'Delayed result' } } },
    });
    await wait.setDownstream(create);
    const triggered = await agent()
      .resource('workflows')
      .trigger({ filterByTk: workflow.id, updateData: encodeURIComponent(JSON.stringify({ name: 'Delay input' })) });
    expect([200, 204]).toContain(triggered.status);
    await vi.waitFor(
      async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution?.status).toBe(EXECUTION_STATUS.STARTED);
        const jobs = await execution.getJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].status).toBe(JOB_STATUS.PENDING);
      },
      { timeout: 10000, interval: 25 },
    );
    await waitForWorkflowIdle(app);
    const [execution] = await workflow.getExecutions();
    expect(await workflow.countExecutions()).toBe(1);
    const identity = { currentUserId: participant.userId, currentRole: participantRole };
    expect(execution.authContext).toEqual(identity);
    expect(execution.tenantId).toBe('B');
    expect(execution.tenantContext.currentTenantId).toBe('B');
    expect(await rows()).toEqual([]);
    const forbidden = await agent().resource('executions').cancel({ filterByTk: execution.id });
    expect(forbidden.status).toBe(403);
    expect((await execution.reload()).status).toBe(EXECUTION_STATUS.STARTED);
    if (cancelled) {
      const response = await agent(manager).resource('executions').cancel({ filterByTk: execution.id });
      expect(response.status).toBe(200);
      expect((await execution.reload()).status).toBe(EXECUTION_STATUS.CANCELED);
      const jobs = await execution.getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe(JOB_STATUS.CANCELED);
    }
    // Wait for the real scheduled callback to settle; an early empty-table check is insufficient.
    // 等待真实到期回调实际结束，不能只在定时器触发前检查业务表为空。
    await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 10000, interval: 25 });
    await outcomes[0];
    await waitForWorkflowIdle(app);
    await execution.reload();
    expect(execution.authContext).toEqual(identity);
    expect(execution.tenantId).toBe('B');
    expect(execution.tenantContext.currentTenantId).toBe('B');
    expect(execution.status).toBe(cancelled ? EXECUTION_STATUS.CANCELED : EXECUTION_STATUS.RESOLVED);
    const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
    expect(jobs.map((job) => [job.nodeId, job.status])).toEqual(
      cancelled
        ? [[wait.id, JOB_STATUS.CANCELED]]
        : [
            [wait.id, JOB_STATUS.RESOLVED],
            [create.id, JOB_STATUS.RESOLVED],
          ],
    );
    expect(await rows()).toEqual(cancelled ? [] : [{ id: 1, name: 'Delayed result', tenantId: 'B' }]);
    expect(await workflow.countExecutions()).toBe(1);
  });
});
