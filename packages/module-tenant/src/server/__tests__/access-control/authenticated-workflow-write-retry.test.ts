import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import WorkflowPlugin, { EXECUTION_STATUS, JOB_STATUS } from '../../../../../module-workflow/src/server';
import { accessConfigHistory } from '../../access-control/config-history';
import type { AccessCollectionIdentity } from '../../access-control/config-store';
import { AccessMainWorkflowWriteRuntime } from '../../access-control/main-workflow-write-runtime';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreFactoryEntry)('authenticated selected workflow write retries', () => {
  let app: MockServer;
  let runtime: AccessMainWorkflowWriteRuntime;
  let source: AccessCollectionIdentity;
  let participant: Model;
  let reviewer: Model;
  let participantToken: string;
  let reviewerToken: string;
  let workflow;
  const participantRole = 'write-retry-participant';
  const reviewerRole = 'write-retry-reviewer';
  const password = 'workflow-write-retry-test-password';
  const agent = (review = false) =>
    app
      .agent()
      .set('Authorization', `Bearer ${review ? reviewerToken : participantToken}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', review ? reviewerRole : participantRole)
      .set('X-Tenant-Id', 'B');

  beforeAll(async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          'workflow',
          {
            name: 'workflow',
            updateResolver: (request) => runtime.resolveUpdate(request, [source]),
            updateTransactionPlanner: (target) => runtime.plan(target, [source]),
          },
        ],
      ],
    });
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    runtime = new AccessMainWorkflowWriteRuntime(app, (request) => plugin.captureDataOperationAuthority(request));
    for (const id of ['H', 'B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    for (const [name, snippets] of [
      [participantRole, []],
      [reviewerRole, ['pm.workflow.workflows']],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets } });
    }
    const users = [];
    const tokens: string[] = [];
    for (const role of [participantRole, reviewerRole]) {
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
      users.push(user);
      tokens.push(signedIn.body.data.token);
    }
    [participant, reviewer] = users;
    [participantToken, reviewerToken] = tokens;
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: 'authenticatedRetryDocuments',
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
    source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: stored.get('name') };
    await app.db.getRepository('collections').create({
      context: {},
      values: { name: 'authenticatedRetryEvents', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
    });
    await app.db.collection(accessConfigHistory).model.sync();
  });

  beforeEach(async () => {
    const model = app.db.getCollection(source.collectionName).model;
    await model.destroy({ where: {}, hooks: false });
    await model.bulkCreate([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'Owned B', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    const current = await runtime.registry.store.read(source);
    await runtime.registry.store.save(
      source,
      { ...configFor(ownerCondition), revision: current?.revision ?? 0 },
      {
        userId: reviewer.get('id'),
      },
    );
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Authenticated selected write retry',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'authenticatedRetryEvents', mode: 1 },
      },
    });
  });

  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  async function rows() {
    return (await app.db.getCollection(source.collectionName).model.findAll({ order: [['id', 'ASC']] })).map((row) =>
      row.get(),
    );
  }

  it.each([false, true])('uses current rules and the authenticated retry actor (revoke G: %s)', async (revoke) => {
    const node = await workflow.createNode({
      type: 'update',
      config: { collection: source.collectionName, params: { filterByTk: 2, values: { name: 'First update' } } },
    });
    const triggered = await agent()
      .resource('workflows')
      .trigger({
        filterByTk: workflow.id,
        updateData: encodeURIComponent(JSON.stringify({})),
      });
    expect([200, 204]).toContain(triggered.status);
    await vi.waitFor(
      async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution?.status).toBe(EXECUTION_STATUS.RESOLVED);
      },
      { timeout: 10000, interval: 50 },
    );
    const [original] = await workflow.getExecutions();
    expect(original.authContext).toEqual({ currentRole: participantRole, currentUserId: participant.get('id') });
    expect(original.tenantId).toBe('B');
    expect(original.tenantContext.currentTenantId).toBe('B');
    const originalJobs = (await original.getJobs()).map((job) => job.toJSON());
    const before = await rows();
    expect(before).toEqual([
      { id: 1, name: 'Owned H', amount: 100, tenantId: 'H' },
      { id: 2, name: 'First update', amount: 200, tenantId: 'B' },
      { id: 3, name: 'Owned C', amount: 300, tenantId: 'C' },
    ]);
    const direct = await agent(true)
      .resource(source.collectionName)
      .update({
        filterByTk: 2,
        values: { name: 'Denied direct write' },
      });
    expect(direct.status).toBe(403);
    const denied = await agent().resource('executions').retry({ filterByTk: original.id });
    expect(denied.status).toBe(403);
    expect(await workflow.countExecutions()).toBe(1);
    expect(await rows()).toEqual(before);

    const current = (await runtime.registry.store.read(source))!;
    const next = configFor({
      type: 'all',
      children: [
        ownerCondition,
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'user.id' },
          right: { type: 'literal', value: String(reviewer.get('id')) },
        },
      ],
    });
    await runtime.registry.store.save(
      source,
      { ...next, revision: current.revision, rules: revoke ? [] : next.rules },
      {
        userId: reviewer.get('id'),
      },
    );
    await node.update({
      config: { collection: source.collectionName, params: { filterByTk: 2, values: { name: 'Retried update' } } },
    });
    const retried = await agent(true).resource('executions').retry({ filterByTk: original.id });
    expect(retried.status).toBe(200);
    expect(await workflow.countExecutions()).toBe(2);
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    expect(execution.id).not.toBe(original.id);
    expect(execution.status).toBe(revoke ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.RESOLVED);
    expect(execution.tenantId).toBe('B');
    expect(execution.tenantContext.currentTenantId).toBe('B');
    expect(execution.authContext).toEqual({ currentRole: reviewerRole, currentUserId: reviewer.get('id') });
    const [job] = await execution.getJobs();
    expect(job.status).toBe(revoke ? JOB_STATUS.ERROR : JOB_STATUS.RESOLVED);
    if (revoke) expect(job.result.message).toMatch(/Record is unavailable/);
    else {
      expect(job.result.data).toHaveLength(1);
      expect(job.result.data[0]).toMatchObject({ id: 2, name: 'Retried update', tenantId: 'B' });
    }
    expect(await rows()).toEqual(
      before.map((row) => (row.id === 2 && !revoke ? { ...row, name: 'Retried update' } : row)),
    );
    await original.reload();
    expect(original.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(original.authContext).toEqual({ currentRole: participantRole, currentUserId: participant.get('id') });
    expect((await original.getJobs()).map((job) => job.toJSON())).toEqual(originalJobs);
  });
});
