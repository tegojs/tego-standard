import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import type PluginWorkflow from '../../Plugin';

describe('workflow query resolver plugin lifecycle', () => {
  let app: MockServer;
  let plugin: PluginWorkflow;
  let mode: 'scoped' | 'empty' | 'denied';
  let workflow;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: [
        'error-handler',
        'collection',
        'user',
        [
          'workflow',
          {
            queryResolver: () => async (request) => {
              if (mode === 'denied') throw new Error('current execution has no access');
              if (mode === 'empty') return [];
              return request.collection.repository.find({
                ...request.query,
                filter: {
                  $and: [request.query.filter || {}, { tenantId: request.context.state.currentTenantId }],
                },
                context: request.context,
                transaction: request.transaction,
              });
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as PluginWorkflow;
    const collection = app.db.collection({
      name: 'queryDocuments',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await app.db.sync();
    await collection.repository.create({ values: { id: 1, title: 'visible', tenantId: 'branch' } });
    await collection.repository.create({ values: { id: 2, title: 'hidden', tenantId: 'other' } });
    // A later options mutation must not replace the executor selection captured at startup.
    plugin.options.queryResolver = () => undefined;
  });

  beforeEach(async () => {
    mode = 'scoped';
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'query resolver execution',
        type: 'collection',
        sync: true,
        enabled: true,
        config: { collection: 'queryDocuments', mode: 1 },
      },
    });
    await workflow.createNode({
      type: 'query',
      config: { collection: 'queryDocuments', multiple: true, failOnEmpty: true },
    });
  });

  afterEach(async () => {
    await workflow.update({ enabled: false });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  async function execute() {
    await plugin.trigger(workflow, {}, { context: { state: { currentTenantId: 'branch' } } });
    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();
    return { execution, job };
  }

  it('persists selected query results in a real execution after startup options change', async () => {
    const { execution, job } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toMatchObject([{ id: 1, title: 'visible' }]);
    expect(job.result).toHaveLength(1);
  });

  it('records authorization errors without saving unrestricted default results', async () => {
    mode = 'denied';
    const { execution, job } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toBe('current execution has no access');
  });

  it('retains failOnEmpty execution status for an empty authorized result', async () => {
    mode = 'empty';
    const { execution, job } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.FAILED);
    expect(job.status).toBe(JOB_STATUS.FAILED);
    expect(job.result).toEqual([]);
  });
});
