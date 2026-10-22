import { createMockServer, type MockServer } from '@tachybase/test';
import type { Collection } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import type { WorkflowDataOperationAuthority } from '../../data-operation-authority';
import type { WorkflowWriteRequest } from '../../instructions/write-resolver';
import type PluginWorkflow from '../../Plugin';

describe.each(['create', 'update'] as const)('workflow %s resolver plugin lifecycle', (action) => {
  let app: MockServer;
  let plugin: PluginWorkflow;
  let documents: Collection;
  let workflow;
  let mode: 'selected' | 'fallback' | 'error' | 'invalid';
  let captured: WorkflowDataOperationAuthority;
  let request: WorkflowWriteRequest;

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
            [`${action}Resolver`]: (input) => {
              captured = plugin.captureDataOperationAuthority(input);
              request = input;
              if (mode === 'fallback') return undefined;
              return async (input) => {
                captured.assertCurrent();
                expect(captured.actionName).toBe(action);
                expect(captured.context).toBe(input.context);
                expect(captured.transaction).toBe(input.transaction);
                expect(input.context.state.currentTenantId).toBe('branch');
                expect(() => plugin.captureDataOperationAuthority({ ...input })).toThrow(/authority/i);
                expect(() => plugin.captureDataOperationAuthority.call(Object.create(plugin), input)).toThrow(
                  /authority/i,
                );
                let result;
                if (action === 'create') {
                  const row = await documents.repository.create({
                    values: { title: input.params.values.title, tenantId: 'branch' },
                    transaction: input.transaction,
                  });
                  result = row.toJSON();
                } else {
                  const records = await documents.repository.update({
                    filterByTk: 2,
                    values: { title: input.params.values.title },
                    transaction: input.transaction,
                  });
                  result = { length: records.length, data: records.map((row) => row.toJSON()) };
                }
                await Promise.resolve();
                captured.assertCurrent();
                if (mode === 'error') throw new Error('write verification failed');
                return mode === 'invalid' ? null : result;
              };
            },
          },
        ],
      ],
    });
    plugin = app.pm.get('workflow') as PluginWorkflow;
    documents = app.db.collection({
      name: 'writeProofDocuments',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await documents.model.sync();
    documents.options.tenancy = 'tenantScoped';
    plugin.options[`${action}Resolver`] = () => {
      throw new Error('startup callback was not captured');
    };
  });
  beforeEach(async () => {
    mode = 'selected';
    captured = undefined;
    request = undefined;
    await documents.model.destroy({ where: {}, hooks: false });
    await documents.model.bulkCreate([
      { id: 1, title: 'owned', tenantId: 'branch' },
      { id: 2, title: 'other', tenantId: 'other' },
    ]);
    workflow = await app.db.getRepository('workflows').create({
      values: {
        title: 'Configured write operation',
        type: 'collection',
        enabled: true,
        sync: true,
        config: { collection: 'writeProofEvents', mode: 1 },
      },
    });
  });
  afterEach(async () => {
    await workflow?.update({ enabled: false });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const node = () =>
    workflow.createNode({
      type: action,
      config: {
        collection: documents.name,
        params: { filterByTk: 1, values: { title: '{{$context.data.title}}' } },
      },
    });
  async function execute() {
    await plugin.trigger(
      workflow,
      { data: { title: 'configured' }, state: { currentTenantId: 'other' } },
      {
        context: { state: { currentTenantId: 'branch' } },
      },
    );
    const [execution] = await workflow.getExecutions({ order: [['id', 'DESC']] });
    return { execution, jobs: await execution.getJobs({ order: [['id', 'ASC']] }) };
  }

  it('captures startup selection and persists the result for downstream nodes', async () => {
    const first = await node();
    const next = await workflow.createNode({
      type: 'query',
      upstreamId: first.id,
      config: {
        collection: documents.name,
        multiple: false,
        params: {
          filter: { id: `{{$jobsMapByNodeKey.${first.key}.${action === 'create' ? 'id' : 'data.0.id'}}}` },
        },
      },
    });
    await first.update({ downstreamId: next.id });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(jobs[0].status).toBe(JOB_STATUS.RESOLVED);
    if (action === 'create') expect(jobs[0].result).toMatchObject({ title: 'configured', tenantId: 'branch' });
    else expect(jobs[0].result).toMatchObject({ length: 1, data: [{ id: 2, title: 'configured' }] });
    // The legacy query is tenant filtered, unlike the selected executor's own response.
    if (action === 'update') expect(jobs[1].result).toBeNull();
    else expect(jobs[1].result).toMatchObject({ title: 'configured', tenantId: 'branch' });
    expect(captured).toMatchObject({ nodeId: first.id, executionId: execution.id, workflowId: workflow.id });
    expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority/i);
    expect(() => captured.assertCurrent()).toThrow(/authority/i);
  });

  it.each(['error', 'invalid'] as const)('rolls back persisted writes and expires proof on %s', async (failure) => {
    mode = failure;
    await node();
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(jobs[0].result.message).toMatch(/write verification failed|executor result/i);
    expect(await documents.model.count()).toBe(2);
    expect((await documents.model.findByPk(2)).get('title')).toBe('other');
    expect(() => plugin.captureDataOperationAuthority(request)).toThrow(/authority/i);
    expect(() => captured.assertCurrent()).toThrow(/authority/i);
  });

  it('retains the original tenant write when explicitly falling back', async () => {
    mode = 'fallback';
    await node();
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    if (action === 'update')
      expect(jobs[0].result).toMatchObject({ length: 1, data: [{ id: 1, title: 'configured' }] });
    else expect(await documents.model.count()).toBe(3);
    expect((await documents.model.findByPk(2)).get('title')).toBe('other');
    expect(() => captured.assertCurrent()).toThrow(/authority/i);
  });

  it('does not grant runtime operation proof to direct instruction calls', async () => {
    const configured = await node();
    const execution = await workflow.createExecution({
      status: EXECUTION_STATUS.STARTED,
      key: workflow.key,
      context: {},
    });
    const processor = plugin.createProcessor(execution);
    await processor.prepare();
    await expect(plugin.instructions.get(action).run(configured, {}, processor)).rejects.toThrow(/authority/i);
    expect(await documents.model.count()).toBe(2);
    expect((await documents.model.findByPk(1)).get('title')).toBe('owned');
  });

  it.each([false, true])('keeps update-or-create independent of the new resolver (existing: %s)', async (existing) => {
    mode = 'error';
    await workflow.createNode({
      type: 'updateorcreate',
      config: {
        collection: documents.name,
        params: { filterByTk: existing ? 1 : 999, values: { title: 'upsert original' } },
      },
    });
    const { execution, jobs } = await execute();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(captured).toBeUndefined();
    if (existing) {
      expect(jobs[0].result).toBe(1);
      expect((await documents.model.findByPk(1)).get('title')).toBe('upsert original');
    } else {
      expect(jobs[0].result).toMatchObject({ title: 'upsert original', tenantId: 'branch' });
      expect(await documents.model.count()).toBe(3);
    }
    expect((await documents.model.findByPk(2)).get('title')).toBe('other');
  });
});
