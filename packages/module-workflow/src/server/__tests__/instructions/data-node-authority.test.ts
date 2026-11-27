import { createMockServer, type MockServer } from '@tachybase/test';
import type { Collection } from '@tego/server';

import { vi } from 'vitest';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import type DelayInstruction from '../../features/delay/DelayInstruction';
import type WorkflowPlugin from '../../Plugin';
import type { WorkflowModel } from '../../types';

vi.setConfig({ hookTimeout: 120000 });

/** Compatibility baseline: configured data nodes are server automation, not the caller's resource actions. */
describe('workflow > configured data node authority', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let documents: Collection;
  let events: Collection;
  let workflow: WorkflowModel;
  let user;
  let reviewer;
  const roleName = 'workflow_participant';
  const reviewerRole = 'workflow_reviewer';

  beforeAll(async () => {
    app = await createMockServer({
      acl: true,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'error-handler', 'users', 'collection-manager', 'auth', 'data-source-manager', 'workflow'],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    await app.db.getRepository('roles').create({
      values: { name: roleName, title: 'Workflow participant', strategy: { actions: [] }, snippets: [] },
    });
    user = await app.db.getRepository('users').create({
      values: { username: 'workflow_participant', roles: [roleName] },
    });
    await app.db.getRepository('roles').create({
      values: {
        name: reviewerRole,
        title: 'Workflow reviewer',
        strategy: { actions: [] },
        snippets: ['pm.workflow.workflows'],
      },
    });
    reviewer = await app.db.getRepository('users').create({
      values: { username: 'workflow_reviewer', roles: [reviewerRole] },
    });
    for (const name of ['workflowAuthorityDocuments', 'workflowAuthorityEvents']) {
      await app.db.getRepository('collections').create({
        context: {},
        values: {
          name,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
          ],
        },
      });
      await app.db.getCollection(name).model.sync();
    }
    documents = app.db.getCollection('workflowAuthorityDocuments');
    events = app.db.getCollection('workflowAuthorityEvents');
  });

  beforeEach(async () => {
    documents.options.tenancy = 'tenantScoped';
    documents.options.legacyDataTenantIds = [];
    await documents.model.destroy({ where: {}, hooks: false });
    await documents.model.bulkCreate([
      { id: 1, name: 'Current', tenantId: 'B' },
      { id: 2, name: 'Descendant', tenantId: 'C' },
      { id: 3, name: 'Other', tenantId: 'H' },
      { id: 4, name: 'Legacy', tenantId: null },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Configured data node authority',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: events.name, mode: 1 },
      },
    });
  });

  afterEach(async () => {
    (plugin.instructions.get('delay') as DelayInstruction).unload();
    await idle();
    await workflow?.update({ enabled: false });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  const actorState = () => ({
    currentTenantId: 'B',
    currentRole: roleName,
    currentUser: { id: user.get('id') },
  });

  async function dataNode(type: 'query' | 'destroy', extra = {}) {
    return workflow.createNode({
      type,
      config: {
        collection: documents.name,
        ...(type === 'query' ? { multiple: true, params: { fields: ['name'], sort: [{ field: 'id' }] } } : {}),
      },
      ...extra,
    });
  }

  async function latest() {
    await idle();
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
    return { execution, jobs };
  }

  async function idle() {
    const runtime = plugin as unknown as { executing: Promise<void> | null; events: unknown[]; pending: unknown[] };
    await vi.waitFor(
      () => {
        expect(runtime.executing).toBeFalsy();
        expect(runtime.events).toHaveLength(0);
        expect(runtime.pending).toHaveLength(0);
      },
      { timeout: 10000, interval: 50 },
    );
  }

  async function trigger(state: Record<string, unknown>, http = false) {
    await plugin.trigger(
      workflow,
      { state: { currentTenantId: 'H', currentRole: 'root', currentUser: { id: 999 } } },
      http ? { httpContext: { state, app } } : { context: { state } },
    );
    return latest();
  }

  function agentFor(actor = user, role = roleName) {
    const agent = app.agent().login(actor) as ReturnType<MockServer['agent']> & {
      set(name: string, value: string): unknown;
    };
    agent.set('X-Role', role);
    return agent;
  }

  async function assertResourceDenied(action: 'list' | 'destroy', actor = user, role = roleName) {
    const response = await agentFor(actor, role)
      .resource(documents.name)
      [action](action === 'destroy' ? { filterByTk: 1 } : {});
    expect(response.status).toBe(403);
  }

  it.each(['query', 'destroy'] as const)(
    'executes configured %s for a caller denied the corresponding direct resource action',
    async (type) => {
      await assertResourceDenied(type === 'query' ? 'list' : 'destroy');
      await dataNode(type);
      const { execution, jobs } = await trigger(actorState(), true);
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
      expect(jobs[0].result).toEqual(type === 'query' ? [{ name: 'Current' }] : 1);
      expect(execution.get('authContext')).toEqual({ currentRole: roleName, currentUserId: user.get('id') });
      expect(execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
      if (type === 'destroy') {
        expect((await documents.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get('id'))).toEqual([
          2, 3, 4,
        ]);
      }
    },
  );

  it.each(['query', 'destroy'] as const)('executes automatic %s without inventing a human role', async (type) => {
    await dataNode(type);
    const { execution, jobs } = await trigger({ currentTenantId: 'B' });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual(type === 'query' ? [{ name: 'Current' }] : 1);
    expect(execution.get('authContext')).toBeNull();
  });

  it.each(['query', 'destroy'] as const)('keeps inherited tenant scope on configured %s', async (type) => {
    documents.options.tenancy = 'tenantInherited';
    await dataNode(type);
    const { execution, jobs } = await trigger({ ...actorState(), currentTenantDescendantIds: ['C'] });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual(type === 'query' ? [{ name: 'Current' }, { name: 'Descendant' }] : 2);
    if (type === 'destroy') {
      expect((await documents.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get('id'))).toEqual([3, 4]);
    }
  });

  it.each(['query', 'destroy'] as const)(
    'does not use event identity to widen %s with missing trusted tenant',
    async (type) => {
      await dataNode(type);
      const { execution, jobs } = await trigger({ currentRole: roleName, currentUser: { id: user.get('id') } });
      if (type === 'query') {
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(jobs[0].result).toEqual([]);
      } else {
        expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
        expect(jobs[0].status).toBe(JOB_STATUS.ERROR);
        expect(await documents.model.count()).toBe(4);
      }
      expect(execution.get('tenantContext')).toBeNull();
    },
  );

  it('runs collection-event automation without requiring target list permission from the writer', async () => {
    await assertResourceDenied('list');
    await dataNode('query');
    await events.repository.create({ values: { name: 'Event' }, context: { state: actorState() } });
    const { execution, jobs } = await latest();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual([{ name: 'Current' }]);
    expect(execution.get('authContext')).toEqual({ currentRole: roleName, currentUserId: user.get('id') });
  });

  it('does not let a participant create or retarget the server automation', async () => {
    const agent = agentFor();
    const create = await agent.resource('workflows.nodes', workflow.id).create({
      values: { type: 'destroy', config: { collection: documents.name } },
    });
    expect(create.status).toBe(403);
    expect(await workflow.countNodes()).toBe(0);
    const node = await dataNode('query');
    const update = await agent.resource('flow_nodes').update({
      filterByTk: node.id,
      values: { type: 'destroy', config: { collection: events.name } },
    });
    expect(update.status).toBe(403);
    await node.reload();
    expect(node.get('type')).toBe('query');
    expect(node.get('config')).toMatchObject({ collection: documents.name });
  });

  it('allows the existing HTTP workflow trigger without granting direct access to its data', async () => {
    documents.options.tenancy = 'shared';
    await assertResourceDenied('list');
    await dataNode('query');
    const response = await agentFor()
      .resource('workflows')
      .trigger({
        filterByTk: workflow.id,
        updateData: encodeURIComponent(JSON.stringify({})),
      });
    expect([200, 204]).toContain(response.status);
    await vi.waitFor(
      async () => {
        const { execution } = await latest();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      },
      { timeout: 10000, interval: 50 },
    );
    const { execution, jobs } = await latest();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual([
      { name: 'Current' },
      { name: 'Descendant' },
      { name: 'Other' },
      { name: 'Legacy' },
    ]);
    expect(execution.get('authContext')).toEqual({ currentRole: roleName, currentUserId: user.get('id') });
  });

  it('denies HTTP retry without workflow management permission', async () => {
    await dataNode('query');
    const original = await trigger(actorState());
    const response = await agentFor().resource('executions').retry({
      filterByTk: original.execution.id,
    });
    expect(response.status).toBe(403);
    expect(await workflow.countExecutions()).toBe(1);
  });

  it('retries over HTTP with workflow management permission and the saved tenant, without target list permission', async () => {
    await assertResourceDenied('list', reviewer, reviewerRole);
    await dataNode('query');
    const original = await trigger(actorState());
    const response = await agentFor(reviewer, reviewerRole).resource('executions').retry({
      filterByTk: original.execution.id,
    });
    expect(response.status).toBe(200);
    const { execution, jobs } = await latest();
    expect(execution.id).not.toBe(original.execution.id);
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toEqual([{ name: 'Current' }]);
    expect(execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
    expect(execution.get('authContext')).toEqual({ currentRole: reviewerRole, currentUserId: reviewer.get('id') });
    expect(await workflow.countExecutions()).toBe(2);
    await original.execution.reload();
    expect(original.execution.get('authContext')).toEqual({ currentRole: roleName, currentUserId: user.get('id') });
  });

  it('restores the original actor and tenant for a delayed configured query without resource grants', async () => {
    await assertResourceDenied('list');
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 60000, endStatus: JOB_STATUS.RESOLVED },
    });
    const query = await dataNode('query', { upstreamId: delay.id });
    await delay.update({ downstreamId: query.id });
    const paused = await trigger(actorState(), true);
    (plugin.instructions.get('delay') as DelayInstruction).unload();
    expect(paused.execution.status).toBe(EXECUTION_STATUS.STARTED);
    expect(paused.jobs[0].status).toBe(JOB_STATUS.PENDING);
    await delay.update({ config: { duration: 0, endStatus: JOB_STATUS.RESOLVED } });
    await (plugin.instructions.get('delay') as DelayInstruction).load();
    await vi.waitFor(
      async () => {
        const { execution, jobs } = await latest();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(jobs).toHaveLength(2);
      },
      { timeout: 10000, interval: 50 },
    );
    const resumed = await latest();
    expect(resumed.jobs[1].result).toEqual([{ name: 'Current' }]);
    expect(resumed.execution.id).toBe(paused.execution.id);
    expect(resumed.execution.get('authContext')).toEqual({ currentRole: roleName, currentUserId: user.get('id') });
    expect(resumed.execution.get('tenantContext')).toMatchObject({ currentTenantId: 'B' });
  });
});
