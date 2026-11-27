import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { Plugin } from '@tego/server';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

// A new application, pool, ACL, plugin and runtime, but deliberately not a new OS process.
describe.skipIf(!coreEntry)('authenticated workflow writes after fresh application startup', () => {
  let active: MockServer | undefined;
  let source: AccessCollectionIdentity;
  const role = 'fresh-app-workflow-member';
  const password = 'fresh-app-workflow-test-password';

  afterEach(async () => {
    await active?.destroy();
    active = undefined;
  });

  async function open(storage: string, skipInstall = false) {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    let runtime: AccessMainWorkflowWriteRuntime;
    // Install the explicit test composition before afterStart can discover overdue jobs.
    class TestWorkflowWriteComposition extends Plugin {
      beforeLoad() {
        const plugin = this.app.pm.get('workflow') as WorkflowPlugin;
        this.app.db.collection(accessConfigHistory);
        runtime = new AccessMainWorkflowWriteRuntime(this.app, (request) =>
          plugin.captureDataOperationAuthority(request),
        );
      }
    }
    const app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage },
      skipInstall,
      extraPlugins: [
        [
          'workflow',
          {
            name: 'workflow',
            createResolver: (request) => runtime.resolveCreate(request, [source]),
            createTransactionPlanner: (target) => runtime.plan(target, [source]),
          },
        ],
        TestWorkflowWriteComposition,
      ],
    });
    active = app;
    return { app, runtime, plugin: app.pm.get('workflow') as WorkflowPlugin };
  }

  it.each([false, true])('restores durable identity and current G (revoke: %s)', async (revoke) => {
    const storage = join(mkdtempSync(join(tmpdir(), 'tego-workflow-fresh-app-')), 'database.sqlite');
    const original = await open(storage);
    const { app, runtime } = original;
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
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
        name: 'freshAppWorkflowDocuments',
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
      values: { name: 'freshAppWorkflowEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
    });
    await app.db.getCollection('tenantAccessRevisions').model.sync();
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
      ],
    });
    await runtime.registry.store.save(source, { ...config, revision: 0 }, { userId: user.get('id') });
    const denied = await agent()
      .resource(source.collectionName)
      .create({ values: { name: 'Denied direct create' } });
    expect(denied.status).toBe(403);

    const workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Fresh application durable write',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'freshAppWorkflowEvents', mode: 1 },
      },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 86400000, endStatus: JOB_STATUS.RESOLVED },
    });
    const create = await workflow.createNode({
      type: 'create',
      upstreamId: delay.id,
      config: { collection: source.collectionName, params: { values: { name: 'Recovered task' } } },
    });
    await delay.setDownstream(create);
    const triggered = await agent()
      .resource('workflows')
      .trigger({ filterByTk: workflow.id, updateData: encodeURIComponent(JSON.stringify({})) });
    expect([200, 204]).toContain(triggered.status);
    await vi.waitFor(
      async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution?.status).toBe(EXECUTION_STATUS.STARTED);
        expect((await execution.getJobs()).map((job) => job.status)).toEqual([JOB_STATUS.PENDING]);
      },
      { timeout: 10000, interval: 50 },
    );
    await waitForWorkflowIdle(app);
    const [execution] = await workflow.getExecutions();
    const [pending] = await execution.getJobs();
    const authContext = { currentRole: role, currentUserId: user.get('id') };
    expect(execution.authContext).toEqual(authContext);
    expect(execution.tenantId).toBe('B');
    expect(execution.tenantContext.currentTenantId).toBe('B');
    const tenantContext = structuredClone(execution.tenantContext);
    expect(await app.db.getCollection(source.collectionName).model.count()).toBe(0);
    const current = (await runtime.registry.store.read(source))!;
    await runtime.registry.store.save(
      source,
      { ...config, revision: current.revision, rules: revoke ? [] : config.rules },
      { userId: user.get('id') },
    );
    // The existing long timer is stopped by normal application destruction, not a private flag.
    await delay.update({ config: { duration: 0, endStatus: JOB_STATUS.RESOLVED } });
    const oldCollection = app.db.getCollection(source.collectionName);
    await app.destroy();
    active = undefined;

    const fresh = await open(storage, true);
    expect(fresh.app).not.toBe(app);
    expect(fresh.app.db).not.toBe(app.db);
    expect(fresh.app.db.sequelize).not.toBe(app.db.sequelize);
    expect(fresh.app.acl).not.toBe(app.acl);
    expect(fresh.plugin).not.toBe(original.plugin);
    expect(fresh.runtime).not.toBe(runtime);
    const collection = fresh.app.db.getCollection(source.collectionName);
    expect(collection).not.toBe(oldCollection);
    expect(collection.options.key).toBe(source.collectionKey);
    expect((await fresh.runtime.registry.store.read(source))?.revision).toBe(current.revision + 1);
    await vi.waitFor(
      async () => {
        const restored = await fresh.app.db.getRepository('executions').findOne({ filterByTk: execution.id });
        expect(restored?.get('status')).toBe(revoke ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
      },
      { timeout: 10000, interval: 50 },
    );
    await waitForWorkflowIdle(fresh.app);
    const restored = await fresh.app.db.getRepository('executions').findOne({ filterByTk: execution.id });
    expect(await fresh.app.db.getRepository('executions').count()).toBe(1);
    expect(restored.get('authContext')).toEqual(authContext);
    expect(restored.get('tenantContext')).toEqual(tenantContext);
    expect(restored.get('tenantId')).toBe('B');
    const jobs = await fresh.app.db.getRepository('jobs').find({ filter: { executionId: execution.id } });
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.get('nodeId') === delay.id)?.get()).toMatchObject({
      id: pending.id,
      status: JOB_STATUS.RESOLVED,
    });
    const created = jobs.find((job) => job.get('nodeId') === create.id)!;
    expect(created.get('upstreamId')).toBe(pending.id);
    expect(created.get('status')).toBe(revoke ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
    if (revoke) expect(created.get('result').message).toMatch(/Record is unavailable/);
    const rows = await collection.model.findAll({ raw: true });
    expect(rows).toEqual(revoke ? [] : [{ id: 1, name: 'Recovered task', tenantId: 'B' }]);
  });
});
