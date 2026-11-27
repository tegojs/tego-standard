import { createMockServer, type MockServer } from '@tachybase/test';
import type { Collection } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import type { WorkflowDataOperationAuthority } from '../../data-operation-authority';
import type DelayInstruction from '../../features/delay/DelayInstruction';
import { DestroyInstruction, type WorkflowDestroyRequest } from '../../instructions/DestroyInstruction';
import { QueryInstruction, type WorkflowQueryRequest } from '../../instructions/QueryInstruction';
import type WorkflowPlugin from '../../Plugin';
import type { WorkflowModel } from '../../types';

describe('workflow > live data operation authority', () => {
  let app: MockServer;
  let plugin: WorkflowPlugin;
  let documents: Collection;
  let workflow: WorkflowModel;
  let query: (request: WorkflowQueryRequest) => Promise<Record<string, unknown>[]>;
  let destroy: (request: WorkflowDestroyRequest) => Promise<number>;
  let plan: (request: object) => void;
  let captured: WorkflowDataOperationAuthority[];
  let requests: object[];
  const captureWorkflowDataOperationAuthority = (request: unknown) => plugin.captureDataOperationAuthority(request);

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            queryResolver: (request) => {
              captureWorkflowDataOperationAuthority(request).assertCurrent();
              return query;
            },
            selectResolver: (request) => {
              captureWorkflowDataOperationAuthority(request).assertCurrent();
              return query;
            },
            destroyResolver: (request) => {
              captureWorkflowDataOperationAuthority(request).assertCurrent();
              return destroy;
            },
            destroyTransactionOptions: (request) => {
              plan(request);
              return undefined;
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    documents = app.db.collection({
      name: 'authorityDocuments',
      fields: [{ name: 'name', type: 'string' }],
    });
    await documents.model.sync();
  });

  beforeEach(async () => {
    captured = [];
    requests = [];
    plan = () => {};
    query = async (request) => {
      const authority = captureWorkflowDataOperationAuthority(request);
      captured.push(authority);
      requests.push(request);
      await Promise.resolve();
      authority.assertCurrent();
      const rows = await documents.repository.find({ fields: ['name'] });
      authority.assertCurrent();
      return rows.map((row) => ({ name: row.get('name') }));
    };
    destroy = async (request) => {
      const authority = captureWorkflowDataOperationAuthority(request);
      captured.push(authority);
      requests.push(request);
      authority.assertCurrent();
      return documents.repository.destroy({ filterByTk: 1, transaction: request.transaction });
    };
    await documents.model.destroy({ where: {}, hooks: false });
    await documents.model.create({ id: 1, name: 'Configured record' });
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Live operation authority',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'authorityEvents', mode: 1 },
      },
    });
  });

  afterEach(async () => {
    (plugin.instructions.get('delay') as DelayInstruction).unload();
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const node = (type: 'query' | 'select' | 'destroy', extra = {}) =>
    workflow.createNode({
      type,
      config: { collection: documents.name, ...(type !== 'destroy' ? { multiple: true } : {}) },
      ...extra,
    });
  async function run() {
    await plugin.trigger(
      workflow,
      { state: { currentRole: 'root' } },
      { context: { state: { currentTenantId: 'B' } } },
    );
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    return { execution, jobs: await execution.getJobs({ order: [['id', 'ASC']] }) };
  }

  it.each(['query', 'select', 'destroy'] as const)(
    'binds %s to the real execution, target, operation and transaction',
    async (type) => {
      const configured = await node(type);
      const { execution, jobs } = await run();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(jobs[0].result).toEqual(type !== 'destroy' ? [{ name: 'Configured record' }] : 1);
      expect(captured[0]).toMatchObject({
        actionName: type !== 'destroy' ? 'list' : 'destroy',
        dataSourceName: 'main',
        collectionName: documents.name,
        workflowId: workflow.id,
        executionId: execution.id,
        nodeId: configured.id,
      });
      expect(captured[0].collection).toBe(documents);
      expect(captured[0].context).toBe((requests[0] as WorkflowQueryRequest).context);
      expect(captured[0].transaction).toBe((requests[0] as WorkflowQueryRequest).transaction);
      expect(Object.isFrozen(captured[0])).toBe(true);
      expect(execution.get('authContext')).toBeNull();
      if (type === 'destroy') expect(await documents.model.count()).toBe(0);
    },
  );

  it.each(['query', 'select', 'destroy'] as const)(
    'expires %s authority and its assertion after completion',
    async (type) => {
      await node(type);
      expect((await run()).execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(() => captureWorkflowDataOperationAuthority(requests[0])).toThrow(/authority/i);
      expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
    },
  );

  it('rejects copied requests and objects with forged context without evaluating getters', async () => {
    const original = query;
    query = async (request) => {
      const forged = Object.defineProperty({}, 'context', {
        get() {
          throw new Error('getter was executed');
        },
      });
      for (const input of [
        { ...request },
        { ...request, context: { state: { currentRole: 'root' } } },
        forged,
        null,
        [],
      ])
        expect(() => captureWorkflowDataOperationAuthority(input)).toThrow(/authority/i);
      return original(request);
    };
    await node('query');
    expect((await run()).execution.status).toBe(EXECUTION_STATUS.RESOLVED);
  });

  it('binds capture to the owning plugin instance', async () => {
    const original = query;
    query = async (request) => {
      expect(() => plugin.captureDataOperationAuthority.call(Object.create(plugin), request)).toThrow(/authority/i);
      return original(request);
    };
    await node('query');
    expect((await run()).execution.status).toBe(EXECUTION_STATUS.RESOLVED);
  });

  it('isolates simultaneously active executions of the same node', async () => {
    await node('query');
    const firstExecution = await workflow.createExecution({
      status: EXECUTION_STATUS.STARTED,
      key: workflow.key,
      context: {},
    });
    const secondExecution = await workflow.createExecution({
      status: EXECUTION_STATUS.STARTED,
      key: workflow.key,
      context: {},
    });
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let firstRequest: WorkflowQueryRequest;
    let firstAuthority: WorkflowDataOperationAuthority;
    const original = query;
    query = async (request) => {
      const authority = captureWorkflowDataOperationAuthority(request);
      if (authority.executionId === firstExecution.id) {
        firstRequest = request;
        firstAuthority = authority;
        firstStarted();
        await blocked;
        authority.assertCurrent();
      } else {
        expect(() => captureWorkflowDataOperationAuthority(firstRequest)).toThrow(/authority/i);
        expect(() => firstAuthority.assertCurrent()).toThrow(/authority/i);
        expect(authority.executionId).toBe(secondExecution.id);
      }
      return original(request);
    };
    const first = plugin.createProcessor(firstExecution).start();
    try {
      await started;
      expect(() => firstAuthority.assertCurrent()).toThrow(/authority/i);
      await plugin.createProcessor(secondExecution).start();
    } finally {
      releaseFirst();
      await first;
    }
    await firstExecution.reload();
    await secondExecution.reload();
    expect([firstExecution.status, secondExecution.status]).toEqual([
      EXECUTION_STATUS.RESOLVED,
      EXECUTION_STATUS.RESOLVED,
    ]);
    expect(captured.map((authority) => authority.executionId)).toEqual([secondExecution.id, firstExecution.id]);
  });

  it('restores the parent scope after a nested Processor finishes', async () => {
    await node('query');
    const nested = await workflow.createExecution({ status: EXECUTION_STATUS.STARTED, key: workflow.key, context: {} });
    let parent: WorkflowDataOperationAuthority;
    const original = query;
    query = async (request) => {
      const authority = captureWorkflowDataOperationAuthority(request);
      if (authority.executionId === nested.id) {
        expect(() => parent.assertCurrent()).toThrow(/authority/i);
      } else {
        parent = authority;
        await plugin.createProcessor(nested).start();
        parent.assertCurrent();
        expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
      }
      return original(request);
    };
    const { execution } = await run();
    await nested.reload();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(nested.status).toBe(EXECUTION_STATUS.RESOLVED);
  });

  it('rejects a target that is no longer registered in its data source', async () => {
    const original = query;
    query = async (request) => {
      const authority = captureWorkflowDataOperationAuthority(request);
      app.db.collections.delete(documents.name);
      try {
        expect(() => authority.assertCurrent()).toThrow(/authority/i);
      } finally {
        app.db.collections.set(documents.name, documents);
      }
      return original(request);
    };
    await node('query');
    expect((await run()).execution.status).toBe(EXECUTION_STATUS.RESOLVED);
  });

  it.each([
    { field: 'currentTenantId', context: 'tenantContext', before: 'B', after: 'C' },
    { field: 'currentUserId', context: 'authContext', before: 28, after: 99 },
    { field: 'currentRole', context: 'authContext', before: 'worker', after: 'operator' },
  ])('rejects a changed persisted execution $field during an active operation', async (item) => {
    await node('query');
    const execution = await workflow.createExecution({
      status: EXECUTION_STATUS.STARTED,
      key: workflow.key,
      context: {},
      tenantContext: { currentTenantId: 'B' },
      authContext: { currentUserId: 28, currentRole: 'worker' },
    });
    const original = query;
    query = async (request) => {
      const authority = captureWorkflowDataOperationAuthority(request);
      expect(authority.identityContext.state).toEqual({
        currentTenantId: 'B',
        currentUserId: 28,
        currentRole: 'worker',
      });
      expect(Object.isFrozen(authority.identityContext.state)).toBe(true);
      await Promise.resolve();
      const state = execution.getDataValue(item.context);
      state[item.field] = item.after;
      try {
        expect(() => authority.assertCurrent()).toThrow(/authority/i);
        expect(() => captureWorkflowDataOperationAuthority(request)).toThrow(/authority/i);
      } finally {
        state[item.field] = item.before;
      }
      return original(request);
    };
    const processor = plugin.createProcessor(execution, {
      context: { state: { currentTenantId: 'H', currentUserId: 99, currentRole: 'operator' } },
    });
    await processor.start();
    expect(execution.status, JSON.stringify(processor.lastSavedJob?.result)).toBe(EXECUTION_STATUS.RESOLVED);
    expect(processor.lastSavedJob?.result).toEqual([{ name: 'Configured record' }]);
  });

  it('preserves synchronous instructions without granting them data operation authority', async () => {
    plugin.registerInstruction('authoritySync', { run: () => ({ status: JOB_STATUS.RESOLVED, result: 42 }) });
    await workflow.createNode({ type: 'authoritySync' });
    const { execution, jobs } = await run();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].result).toBe(42);
  });

  it('creates fresh authority after restoring a persisted delayed execution', async () => {
    const first = await node('query');
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 60000, endStatus: JOB_STATUS.RESOLVED },
      upstreamId: first.id,
    });
    const last = await node('query', { upstreamId: delay.id });
    await first.update({ downstreamId: delay.id });
    await delay.update({ downstreamId: last.id });
    const { execution, jobs } = await run();
    const instruction = plugin.instructions.get('delay') as DelayInstruction;
    instruction.unload();
    expect(execution.status).toBe(EXECUTION_STATUS.STARTED);
    expect(jobs.map((job) => job.status)).toEqual([JOB_STATUS.RESOLVED, JOB_STATUS.PENDING]);
    expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
    await delay.update({ config: { duration: 0, endStatus: JOB_STATUS.RESOLVED } });
    await instruction.load();
    await vi.waitFor(
      async () => {
        await execution.reload();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      },
      { timeout: 10000, interval: 50 },
    );
    const resumed = await execution.getJobs({ order: [['id', 'ASC']] });
    expect(resumed[2].result).toEqual([{ name: 'Configured record' }]);
    expect(captured.map((authority) => authority.nodeId)).toEqual([first.id, last.id]);
    expect(captured.map((authority) => authority.executionId)).toEqual([execution.id, execution.id]);
  });

  it('rejects an earlier node request during the next query of the same execution', async () => {
    const first = await node('query');
    const second = await node('query', { upstreamId: first.id });
    await first.update({ downstreamId: second.id });
    const original = query;
    query = async (request) => {
      if (requests.length) {
        expect(() => captureWorkflowDataOperationAuthority(requests[0])).toThrow(/authority/i);
        expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
      }
      return original(request);
    };
    const { execution, jobs } = await run();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs.map((job) => job.result)).toEqual([[{ name: 'Configured record' }], [{ name: 'Configured record' }]]);
    expect(captured.map((authority) => authority.nodeId)).toEqual([first.id, second.id]);
  });

  it('expires the proof on an executor error and preserves its original error', async () => {
    query = async (request) => {
      captured.push(captureWorkflowDataOperationAuthority(request));
      requests.push(request);
      throw new Error('business query failure');
    };
    await node('query');
    const { execution, jobs } = await run();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(jobs[0].result.message).toBe('business query failure');
    expect(() => captureWorkflowDataOperationAuthority(requests[0])).toThrow(/authority/i);
    expect(() => captured[0].assertCurrent()).toThrow(/authority/i);
  });

  it('does not grant operation authority to transaction planning', async () => {
    plan = (request) => {
      expect(() => captureWorkflowDataOperationAuthority(request)).toThrow(/authority/i);
    };
    await node('destroy');
    expect((await run()).jobs[0].result).toBe(1);
  });

  it.each(['query', 'destroy'] as const)(
    'rejects direct %s instruction calls outside Processor execution',
    async (type) => {
      const configured = await node(type);
      const execution = await workflow.createExecution({
        status: EXECUTION_STATUS.STARTED,
        key: workflow.key,
        context: {},
      });
      const processor = plugin.createProcessor(execution);
      await processor.prepare();
      const instruction =
        type === 'query'
          ? new QueryInstruction(plugin, (request) => {
              captureWorkflowDataOperationAuthority(request);
              return query;
            })
          : new DestroyInstruction(plugin, (request) => {
              captureWorkflowDataOperationAuthority(request);
              return destroy;
            });
      await expect(instruction.run(configured, {}, processor)).rejects.toThrow(/authority/i);
      expect(await documents.model.count()).toBe(1);
    },
  );
});
