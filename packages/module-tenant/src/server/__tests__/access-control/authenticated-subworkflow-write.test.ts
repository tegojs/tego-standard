import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated selected subworkflow writes', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { sync: true, allow: true },
    { sync: false, allow: true },
    { sync: true, allow: false },
    { sync: false, allow: false },
  ])('uses the child operation and inherited identity: sync=$sync, allow=$allow', async ({ sync, allow }) => {
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
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    const role = 'subworkflow-write-member';
    const password = 'subworkflow-write-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
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
    const agent = () =>
      app
        .agent()
        .set('Authorization', `Bearer ${signedIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(String(checked.body.data.id)).toBe(String(user.get('id')));
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'authenticatedSubworkflowDocuments',
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
      values: { name: 'authenticatedSubworkflowEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
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
          right: { type: 'literal', value: String(user.get('id')) },
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
      source,
      { ...config, revision: 0, rules: allow ? config.rules : [] },
      { userId: user.get('id') },
    );
    expect(await app.db.getCollection(source.collectionName).model.count()).toBe(0);
    const denied = await agent()
      .resource(source.collectionName)
      .create({ values: { name: 'Denied direct create' } });
    expect(denied.status).toBe(403);

    const workflows = app.db.getRepository('workflows');
    const child = await workflows.create({
      values: {
        title: 'Configured child create',
        type: 'collection',
        enabled: true,
        sync,
        config: { collection: 'authenticatedSubworkflowEvents', mode: 1 },
      },
    });
    const create = await child.createNode({
      type: 'create',
      config: { collection: source.collectionName, params: { values: { name: 'Child result' } } },
    });
    const parent = await workflows.create({
      values: {
        title: 'Authenticated parent',
        type: 'collection',
        enabled: true,
        sync: false,
        config: { collection: 'authenticatedSubworkflowEvents', mode: 1 },
      },
    });
    const trigger = await parent.createNode({
      type: 'trigger-instruction',
      config: {
        workflowKey: child.key,
        sourceArray: [{ sourcePath: '{{$context.data.updateData}}', keyName: 'data' }],
      },
    });
    const response = await agent()
      .resource('workflows')
      .trigger({
        filterByTk: parent.id,
        updateData: encodeURIComponent(JSON.stringify({ name: 'Parent input' })),
      });
    expect([200, 204]).toContain(response.status);
    await vi.waitFor(
      async () => {
        const [execution] = await parent.getExecutions();
        expect(execution).toBeTruthy();
        expect([EXECUTION_STATUS.QUEUEING, EXECUTION_STATUS.STARTED]).not.toContain(execution.status);
      },
      { timeout: 10000, interval: 50 },
    );
    await waitForWorkflowIdle(app);
    const [parentExecution] = await parent.getExecutions();
    const [childExecution] = await child.getExecutions();
    expect(await parent.countExecutions()).toBe(1);
    expect(await child.countExecutions()).toBe(1);
    const identity = { currentRole: role, currentUserId: user.get('id') };
    for (const execution of [parentExecution, childExecution]) {
      expect(execution.authContext).toEqual(identity);
      expect(execution.tenantId).toBe('B');
      expect(execution.tenantContext.currentTenantId).toBe('B');
    }
    expect(childExecution.tenantContext).toEqual(parentExecution.tenantContext);
    expect(childExecution.context.data).toEqual({ name: 'Parent input' });
    const childJobs = await childExecution.getJobs();
    expect(childJobs).toHaveLength(1);
    const [childJob] = childJobs;
    expect(childJob.nodeId).toBe(create.id);
    expect(childJob.status).toBe(allow ? JOB_STATUS.RESOLVED : JOB_STATUS.ERROR);
    expect(childExecution.status).toBe(allow ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.ERROR);
    const parentJobs = await parentExecution.getJobs();
    expect(parentJobs).toHaveLength(1);
    const [parentJob] = parentJobs;
    expect(parentJob.nodeId).toBe(trigger.id);
    expect(parentJob.status).toBe(allow ? JOB_STATUS.RESOLVED : sync ? JOB_STATUS.FAILED : JOB_STATUS.ERROR);
    expect(parentExecution.status).toBe(
      allow ? EXECUTION_STATUS.RESOLVED : sync ? EXECUTION_STATUS.FAILED : EXECUTION_STATUS.ERROR,
    );
    if (!allow) {
      expect(childJob.result.message).toMatch(/Record is unavailable/);
    }
    if (!sync) {
      expect(childExecution.parentId).toBe(parentExecution.id);
      expect(childExecution.parentNode).toBe(trigger.id);
    }
    const rows = await app.db.getCollection(source.collectionName).model.findAll({ raw: true });
    expect(rows).toEqual(allow ? [{ id: 1, name: 'Child result', tenantId: 'B' }] : []);
  });
});
