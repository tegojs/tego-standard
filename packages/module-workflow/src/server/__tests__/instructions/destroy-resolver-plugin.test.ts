import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import type PluginWorkflow from '../../Plugin';

describe('workflow destroy resolver plugin lifecycle', () => {
  let app: MockServer;
  let plugin: PluginWorkflow;
  let mode: 'scoped' | 'denied' | 'post-write-error' | 'invalid-result';
  let workflow;
  let collection;

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
            destroyResolver: () => async (request) => {
              if (mode === 'denied') throw new Error('current execution has no delete access');
              const count = await request.collection.repository.destroy({
                filter: {
                  $and: [request.params.filter || {}, { tenantId: request.context.state.currentTenantId }],
                },
                context: request.context,
                transaction: request.transaction,
              });
              if (mode === 'post-write-error') throw new Error('post-write check failed');
              // Repository.destroy may return undefined when its filter matches no primary keys.
              return mode === 'invalid-result' ? undefined : (count ?? 0);
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as PluginWorkflow;
    collection = app.db.collection({
      name: 'destroyDocuments',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await collection.model.sync();
    // Selection is captured at startup, as with the query resolver.
    plugin.options.destroyResolver = () => undefined;
  });

  beforeEach(async () => {
    mode = 'scoped';
    await collection.model.destroy({ where: {} });
    await collection.model.bulkCreate([
      { id: 1, title: 'owned', tenantId: 'branch' },
      { id: 2, title: 'other', tenantId: 'other' },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'destroy resolver execution',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'destroyDocuments', mode: 1 },
      },
    });
    await workflow.createNode({
      type: 'destroy',
      config: { collection: 'destroyDocuments', params: { filter: {} } },
    });
  });

  afterEach(async () => {
    await workflow.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  async function execute(data: object = { state: { currentTenantId: 'other' } }) {
    await plugin.trigger(workflow, data, { context: { state: { currentTenantId: 'branch' } } });
    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();
    const rows = await collection.repository.find({ sort: ['id'] });
    return { execution, job, ids: rows.map((row) => row.get('id')) };
  }

  it('persists the selected deletion count and preserves other tenant rows after options change', async () => {
    const { execution, job, ids } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toBe(1);
    expect(ids).toEqual([2]);
  });

  it('passes resolved node filters to the executor and retains a valid zero-deletion result', async () => {
    const [node] = await workflow.getNodes();
    await node.update({
      config: { collection: 'destroyDocuments', params: { filter: { id: '{{$context.data.id}}' } } },
    });
    const { execution, job, ids } = await execute({ data: { id: 2 }, state: { currentTenantId: 'other' } });
    expect(job.result).toBe(0);
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(ids).toEqual([1, 2]);
  });

  it.each(['denied', 'post-write-error', 'invalid-result'] as const)(
    'records a failed execution without persisting deletions: %s',
    async (failure) => {
      mode = failure;
      const { execution, job, ids } = await execute();
      expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
      expect(job.status).toBe(JOB_STATUS.ERROR);
      expect(job.result.message).toMatch(/delete access|post-write check|Invalid destroy executor result/);
      expect(ids).toEqual([1, 2]);
    },
  );
});
