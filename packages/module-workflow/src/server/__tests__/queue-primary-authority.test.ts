import { createMockServer, type MockServer } from '@tachybase/test';

import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { EXECUTION_STATUS, JOB_STATUS } from '../constants';
import { waitForFastAssertion, waitForWorkflowIdle } from './utils';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Independent real pools with divergent schemas; this does not simulate WAL replication.
describe.skipIf(!postgresUrl)('workflow durable queue primary discovery', () => {
  let app: MockServer;

  beforeAll(async () => {
    const dedicated = isolatedPostgresDatabase(postgresUrl!);
    const connection = { ...dedicated.options };
    await dedicated.close();
    app = await createMockServer({
      database: {
        ...connection,
        replication: {
          write: connection,
          read: [{ ...connection, dialectOptions: { application_name: 'stale-workflow-queue' } }],
        },
      },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
      beforeInstall: async (server) => {
        server.db.sequelize.addHook('afterConnect', async (client, config) => {
          if (config.dialectOptions?.application_name === 'stale-workflow-queue')
            await client.query('SET search_path TO stale_workflow_queue, public');
        });
      },
    });
    app.db.collection({
      name: 'queuedTenantResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'label', type: 'string' },
      ],
    });
    app.db.collection({ name: 'queuedTenantSources', fields: [{ name: 'label', type: 'string' }] });
    await app.db.sync();
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await app.db.sequelize.query('DROP SCHEMA IF EXISTS stale_workflow_queue CASCADE');
    } finally {
      await app.destroy();
    }
  });

  afterEach(async () => {
    await app.db.sequelize.query('DROP SCHEMA IF EXISTS stale_workflow_queue CASCADE');
  });

  it('loads a primary-only workflow when preparing a persisted tenant execution', async () => {
    await waitForWorkflowIdle(app);
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', enabled: true, config: { collection: 'queuedTenantSources', mode: 1 } },
    });
    const label = 'Primary-only workflow configuration';
    await workflow.createNode({
      type: 'create',
      config: { collection: 'queuedTenantResults', params: { values: { label } } },
    });
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.workflows (LIKE public.workflows INCLUDING ALL)');
    const workflows = app.db.getCollection('workflows').model;
    expect(await workflows.findByPk(workflow.id)).toBeNull();
    expect(await workflows.findByPk(workflow.id, { useMaster: true })).not.toBeNull();
    const persisted = await app.db.getCollection('executions').model.findByPk(execution.id, { useMaster: true });
    expect(persisted.workflow).toBeUndefined();

    await app.pm.get('workflow').createProcessor(persisted).start();

    await execution.reload({ useMaster: true });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    const rows = await app.db.getCollection('queuedTenantResults').model.findAll({ where: { label }, useMaster: true });
    expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([
      ['B', 'Primary-only workflow configuration'],
    ]);
  });

  it('resumes primary-only queued executions under each persisted tenant after a real restart', async () => {
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'collection',
        enabled: true,
        config: { collection: 'queuedTenantSources', mode: 1 },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'queuedTenantResults', params: { values: { label: 'Recovered owner task' } } },
    });
    await app.stop();
    await app.db.reconnect();
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.executions (LIKE public.executions INCLUDING ALL)');
    const executions = [];
    for (const tenantId of ['B', 'H']) {
      executions.push(
        await workflow.createExecution({
          key: workflow.key,
          status: EXECUTION_STATUS.QUEUEING,
          context: { data: { label: `${tenantId} source` } },
          tenantId,
          tenantContext: {
            currentTenant: { id: tenantId },
            currentTenantId: tenantId,
            currentTenancyMode: 'tenantScoped',
            currentTenantDescendantIds: [],
            currentLegacyDataTenantIds: [],
          },
        }),
      );
    }
    const model = app.db.getCollection('executions').model;
    expect(await model.count({ where: { workflowId: workflow.id } })).toBe(0);
    expect(await model.count({ where: { workflowId: workflow.id }, useMaster: true })).toBe(2);
    await app.start();
    await waitForWorkflowIdle(app);
    const statuses = [];
    for (const execution of executions) {
      await execution.reload({ useMaster: true });
      statuses.push(execution.status);
    }
    expect(statuses).toEqual([EXECUTION_STATUS.RESOLVED, EXECUTION_STATUS.RESOLVED]);
    const results = await app.db.getCollection('queuedTenantResults').model.findAll({
      where: { label: 'Recovered owner task' },
      useMaster: true,
      order: [['id', 'ASC']],
    });
    expect(results.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([
      ['B', 'Recovered owner task'],
      ['H', 'Recovered owner task'],
    ]);
  });

  it('loads current primary node configuration for a recovered tenant task', async () => {
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'collection',
        enabled: true,
        config: { collection: 'queuedTenantSources', mode: 1 },
      },
    });
    const node = await workflow.createNode({
      type: 'create',
      config: { collection: 'queuedTenantResults', params: { values: { label: 'Obsolete operation' } } },
    });
    await app.stop();
    await app.db.reconnect();
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.flow_nodes (LIKE public.flow_nodes INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO stale_workflow_queue.flow_nodes SELECT * FROM public.flow_nodes');
    await node.update({
      config: { collection: 'queuedTenantResults', params: { values: { label: 'Current operation' } } },
    });
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.QUEUEING,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    const nodes = app.db.getCollection('flow_nodes').model;
    expect((await nodes.findByPk(node.id)).get('config').params.values.label).toBe('Obsolete operation');
    expect((await nodes.findByPk(node.id, { useMaster: true })).get('config').params.values.label).toBe(
      'Current operation',
    );

    await app.start();
    await waitForWorkflowIdle(app);
    await execution.reload({ useMaster: true });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    const results = await app.db.getCollection('queuedTenantResults').model.findAll({
      where: { label: ['Obsolete operation', 'Current operation'] },
      useMaster: true,
    });
    expect(results.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Current operation']]);
  });

  it('resumes a tenant task using committed primary results from earlier nodes', async () => {
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'collection',
        enabled: true,
        config: { collection: 'queuedTenantSources', mode: 1 },
      },
    });
    const producer = await workflow.createNode({
      type: 'create',
      config: { collection: 'queuedTenantResults', params: { values: { label: 'Producer' } } },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      upstreamId: producer.id,
      config: { duration: 86400000, endStatus: JOB_STATUS.RESOLVED },
    });
    const consumer = await workflow.createNode({
      type: 'create',
      upstreamId: delay.id,
      config: {
        collection: 'queuedTenantResults',
        params: { values: { label: `{{$jobsMapByNodeKey.${producer.key}.label}}` } },
      },
    });
    await producer.setDownstream(delay);
    await delay.setDownstream(consumer);
    await app.stop();
    await app.db.reconnect();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    const previous = await execution.createJob({
      nodeId: producer.id,
      nodeKey: producer.key,
      status: JOB_STATUS.RESOLVED,
      result: { label: 'Obsolete input' },
    });
    const pending = await execution.createJob({
      nodeId: delay.id,
      nodeKey: delay.key,
      upstreamId: previous.id,
      status: JOB_STATUS.PENDING,
      result: null,
    });
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.jobs (LIKE public.jobs INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO stale_workflow_queue.jobs SELECT * FROM public.jobs');
    await previous.update({ result: { label: 'Committed input' } });
    const jobs = app.db.getCollection('jobs').model;
    expect((await jobs.findByPk(previous.id)).get('result')).toEqual({ label: 'Obsolete input' });
    expect((await jobs.findByPk(previous.id, { useMaster: true })).get('result')).toEqual({ label: 'Committed input' });

    await app.start();
    const plugin = app.pm.get('workflow');
    pending.execution = execution;
    await plugin.resume(pending);
    await waitForWorkflowIdle(app);
    await execution.reload({ useMaster: true });
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    const results = await app.db.getCollection('queuedTenantResults').model.findAll({
      where: { label: ['Obsolete input', 'Committed input'] },
      useMaster: true,
    });
    expect(results.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Committed input']]);
  });

  it('discovers primary-only overdue delay jobs for each persisted tenant after restart', async () => {
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'collection',
        enabled: true,
        config: { collection: 'queuedTenantSources', mode: 1 },
      },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 0, endStatus: JOB_STATUS.RESOLVED },
    });
    const consumer = await workflow.createNode({
      type: 'create',
      upstreamId: delay.id,
      config: { collection: 'queuedTenantResults', params: { values: { label: 'Recovered delay task' } } },
    });
    await delay.setDownstream(consumer);
    await app.stop();
    await app.db.reconnect();
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.jobs (LIKE public.jobs INCLUDING ALL)');
    const executions = [];
    const jobIds = [];
    for (const tenantId of ['B', 'H']) {
      const execution = await workflow.createExecution({
        key: workflow.key,
        status: EXECUTION_STATUS.STARTED,
        context: {},
        tenantId,
        tenantContext: {
          currentTenant: { id: tenantId },
          currentTenantId: tenantId,
          currentTenancyMode: 'tenantScoped',
          currentTenantDescendantIds: [],
          currentLegacyDataTenantIds: [],
        },
      });
      const pending = await execution.createJob({
        nodeId: delay.id,
        nodeKey: delay.key,
        status: JOB_STATUS.PENDING,
        result: null,
      });
      executions.push(execution);
      jobIds.push(pending.id);
    }
    const jobs = app.db.getCollection('jobs').model;
    expect(await jobs.count({ where: { id: jobIds } })).toBe(0);
    expect(await jobs.count({ where: { id: jobIds }, useMaster: true })).toBe(2);

    await app.start();
    await waitForFastAssertion(async () => {
      const statuses = [];
      for (const execution of executions) {
        await execution.reload({ useMaster: true });
        statuses.push(execution.status);
      }
      expect(statuses).toEqual([EXECUTION_STATUS.RESOLVED, EXECUTION_STATUS.RESOLVED]);
    });
    await waitForWorkflowIdle(app);
    const results = await app.db.getCollection('queuedTenantResults').model.findAll({
      where: { label: 'Recovered delay task' },
      useMaster: true,
      order: [['tenantId', 'ASC']],
    });
    expect(results.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([
      ['B', 'Recovered delay task'],
      ['H', 'Recovered delay task'],
    ]);
  });

  it.each([
    ['primary-only execution', false],
    ['cancelled execution', false],
    ['cancelled execution', true],
  ])('resumes a job against current primary state: %s, cached=%s', async (state, cached) => {
    await waitForWorkflowIdle(app);
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', enabled: true, config: { collection: 'queuedTenantSources', mode: 1 } },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 0, endStatus: JOB_STATUS.RESOLVED },
    });
    const label = `Current resume ${state}, cached=${cached}`;
    const consumer = await workflow.createNode({
      type: 'create',
      upstreamId: delay.id,
      config: { collection: 'queuedTenantResults', params: { values: { label } } },
    });
    await delay.setDownstream(consumer);
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    const pending = await execution.createJob({
      nodeId: delay.id,
      nodeKey: delay.key,
      status: JOB_STATUS.PENDING,
      result: null,
    });
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.executions (LIKE public.executions INCLUDING ALL)');
    const executions = app.db.getCollection('executions').model;
    const cachedExecution = cached ? await executions.findByPk(execution.id, { useMaster: true }) : undefined;
    if (state === 'cancelled execution') {
      await app.db.sequelize.query('INSERT INTO stale_workflow_queue.executions SELECT * FROM public.executions');
      await execution.update({ status: EXECUTION_STATUS.CANCELED });
      expect((await executions.findByPk(execution.id)).status).toBe(EXECUTION_STATUS.STARTED);
      expect((await executions.findByPk(execution.id, { useMaster: true })).status).toBe(EXECUTION_STATUS.CANCELED);
    } else {
      expect(await executions.findByPk(execution.id)).toBeNull();
      expect((await executions.findByPk(execution.id, { useMaster: true })).status).toBe(EXECUTION_STATUS.STARTED);
    }
    const job = await app.db.getCollection('jobs').model.findByPk(pending.id, { useMaster: true });
    expect(job.execution).toBeUndefined();
    if (cached) job.execution = cachedExecution;

    await app.pm.get('workflow').resume(job);
    await waitForWorkflowIdle(app);

    await execution.reload({ useMaster: true });
    const rows = await app.db.getCollection('queuedTenantResults').model.findAll({ where: { label }, useMaster: true });
    expect({ status: execution.status, rows: rows.map((row) => [row.get('tenantId'), row.get('label')]) }).toEqual(
      state === 'cancelled execution'
        ? { status: EXECUTION_STATUS.CANCELED, rows: [] }
        : { status: EXECUTION_STATUS.RESOLVED, rows: [['B', 'Current resume primary-only execution, cached=false']] },
    );
  });

  it.each(['primary-only pending job', 'cancelled parent'])(
    'completes a child against current parent state: %s',
    async (state) => {
      await waitForWorkflowIdle(app);
      const workflows = app.db.getRepository('workflows');
      const config = { collection: 'queuedTenantSources', mode: 1 };
      const child = await workflows.create({ values: { type: 'collection', enabled: true, config } });
      const parent = await workflows.create({ values: { type: 'collection', enabled: true, config } });
      const trigger = await parent.createNode({ type: 'trigger-instruction', config: { workflowKey: child.key } });
      const label = `Child completion ${state}`;
      const consumer = await parent.createNode({
        type: 'create',
        upstreamId: trigger.id,
        config: { collection: 'queuedTenantResults', params: { values: { label } } },
      });
      await trigger.setDownstream(consumer);
      const tenantContext = {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      };
      const execution = await parent.createExecution({
        key: parent.key,
        status: EXECUTION_STATUS.STARTED,
        context: {},
        tenantId: 'B',
        tenantContext,
      });
      const pending = await execution.createJob({
        nodeId: trigger.id,
        nodeKey: trigger.key,
        status: JOB_STATUS.PENDING,
        result: null,
      });
      await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
      await app.db.sequelize.query(
        'CREATE TABLE stale_workflow_queue.executions (LIKE public.executions INCLUDING ALL)',
      );
      await app.db.sequelize.query('INSERT INTO stale_workflow_queue.executions SELECT * FROM public.executions');
      await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.jobs (LIKE public.jobs INCLUDING ALL)');
      await app.db.sequelize.query('INSERT INTO stale_workflow_queue.jobs SELECT * FROM public.jobs');
      if (state === 'primary-only pending job') {
        await app.db.sequelize.query('DELETE FROM stale_workflow_queue.jobs WHERE id = $jobId', {
          bind: { jobId: pending.id },
        });
        const jobs = app.db.getCollection('jobs').model;
        expect(await jobs.findByPk(pending.id)).toBeNull();
        expect((await jobs.findByPk(pending.id, { useMaster: true })).status).toBe(JOB_STATUS.PENDING);
      } else {
        await execution.update({ status: EXECUTION_STATUS.CANCELED });
        const executions = app.db.getCollection('executions').model;
        expect((await executions.findByPk(execution.id)).status).toBe(EXECUTION_STATUS.STARTED);
        expect((await executions.findByPk(execution.id, { useMaster: true })).status).toBe(EXECUTION_STATUS.CANCELED);
      }
      const childExecution = await child.createExecution({
        key: child.key,
        status: EXECUTION_STATUS.QUEUEING,
        context: {},
        tenantId: 'B',
        tenantContext,
        parentId: execution.id,
        parentNode: trigger.id,
      });
      app.pm.get('workflow').dispatch();
      await waitForWorkflowIdle(app);
      expect((await childExecution.reload({ useMaster: true })).status).toBe(EXECUTION_STATUS.RESOLVED);
      const rows = await app.db.getCollection('queuedTenantResults').model.findAll({
        where: { label },
        useMaster: true,
      });
      const actual = {
        status: (await execution.reload({ useMaster: true })).status,
        rows: rows.map((row) => [row.get('tenantId'), row.get('label')]),
      };
      expect(actual).toEqual(
        state === 'primary-only pending job'
          ? { status: EXECUTION_STATUS.RESOLVED, rows: [['B', 'Child completion primary-only pending job']] }
          : { status: EXECUTION_STATUS.CANCELED, rows: [] },
      );
    },
  );

  it.each(['before stop', 'after stop'])(
    'removes primary-only collection listeners when disabled %s',
    async (phase) => {
      await waitForWorkflowIdle(app);
      await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
      await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.workflows (LIKE public.workflows INCLUDING ALL)');
      await app.db.sequelize.query('INSERT INTO stale_workflow_queue.workflows SELECT * FROM public.workflows');
      const workflow = await app.db.getRepository('workflows').create({
        values: { type: 'collection', enabled: true, config: { collection: 'queuedTenantSources', mode: 1 } },
      });
      const label = `Restarted collection event ${phase}`;
      await workflow.createNode({
        type: 'create',
        config: { collection: 'queuedTenantResults', params: { values: { label } } },
      });
      const workflows = app.db.getCollection('workflows').model;
      expect(await workflows.findByPk(workflow.id)).toBeNull();
      expect((await workflows.findByPk(workflow.id, { useMaster: true })).enabled).toBe(true);
      const context = {
        state: {
          currentTenant: { id: 'B' },
          currentTenantId: 'B',
          currentTenancyMode: 'tenantScoped',
          currentTenantDescendantIds: [],
          currentLegacyDataTenantIds: [],
        },
      };
      try {
        if (phase === 'before stop')
          await workflows.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
        await app.stop();
        await app.db.reconnect();
        if (phase === 'after stop')
          await workflows.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
        await app.start();
        await app.db
          .getRepository('queuedTenantSources')
          .create({ values: { label: 'Disabled source event' }, context });
        await waitForWorkflowIdle(app);
        expect(await workflow.countExecutions({ useMaster: true })).toBe(0);
        expect(
          await app.db.getCollection('queuedTenantResults').model.count({
            where: { label },
            useMaster: true,
          }),
        ).toBe(0);

        await workflows.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });
        // Let this row catch up before the positive control; Processor's workflow lookup is a separate boundary.
        await app.db.sequelize.query(
          'INSERT INTO stale_workflow_queue.workflows SELECT * FROM public.workflows WHERE id = $workflowId',
          { bind: { workflowId: workflow.id } },
        );
        await app.stop();
        await app.db.reconnect();
        await app.start();
        await app.db
          .getRepository('queuedTenantSources')
          .create({ values: { label: 'Enabled source event' }, context });
        await waitForWorkflowIdle(app);
        const rows = await app.db.getCollection('queuedTenantResults').model.findAll({
          where: { label },
          useMaster: true,
        });
        expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', label]]);
        expect(await workflow.countExecutions({ useMaster: true })).toBe(1);
      } finally {
        await workflows.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
        app.pm.get('workflow').toggle(workflow, false);
        await waitForWorkflowIdle(app);
      }
    },
  );

  it.each([false, true])('does not select a primary-disabled child workflow with sync=%s', async (sync) => {
    await waitForWorkflowIdle(app);
    const workflows = app.db.getRepository('workflows');
    const config = { collection: 'queuedTenantSources', mode: 1 };
    const child = await workflows.create({ values: { type: 'collection', enabled: true, sync, config } });
    const label = `Disabled child ${sync}`;
    await child.createNode({
      type: 'create',
      config: { collection: 'queuedTenantResults', params: { values: { label } } },
    });
    const parent = await workflows.create({ values: { type: 'collection', enabled: true, config } });
    await parent.createNode({ type: 'trigger-instruction', config: { workflowKey: child.key } });
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.workflows (LIKE public.workflows INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO stale_workflow_queue.workflows SELECT * FROM public.workflows');
    const model = app.db.getCollection('workflows').model;
    // Simulate another writer's committed disable without emitting a local workflow hook.
    await model.update({ enabled: false }, { where: { id: child.id } });
    expect((await model.findByPk(child.id)).enabled).toBe(true);
    expect((await model.findByPk(child.id, { useMaster: true })).enabled).toBe(false);
    const execution = await parent.createExecution({
      key: parent.key,
      status: EXECUTION_STATUS.QUEUEING,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    app.pm.get('workflow').dispatch();
    await waitForWorkflowIdle(app);
    const actual = {
      status: (await execution.reload({ useMaster: true })).status,
      children: await child.countExecutions({ useMaster: true }),
      resultCount: await app.db.getCollection('queuedTenantResults').model.count({ where: { label }, useMaster: true }),
    };
    expect(actual).toEqual({ status: EXECUTION_STATUS.FAILED, children: 0, resultCount: 0 });
  });

  it.each([false, true])('keeps a primary-cancelled tenant delay stopped when cached execution=%s', async (cached) => {
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'collection',
        enabled: true,
        config: { collection: 'queuedTenantSources', mode: 1 },
      },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 3000, endStatus: JOB_STATUS.RESOLVED },
    });
    const label = `Cancelled delay task ${cached}`;
    const consumer = await workflow.createNode({
      type: 'create',
      upstreamId: delay.id,
      config: { collection: 'queuedTenantResults', params: { values: { label } } },
    });
    await delay.setDownstream(consumer);
    await app.stop();
    await app.db.reconnect();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    const pending = await execution.createJob({
      nodeId: delay.id,
      nodeKey: delay.key,
      status: JOB_STATUS.PENDING,
      result: null,
    });
    await app.db.sequelize.query('CREATE SCHEMA stale_workflow_queue');
    await app.db.sequelize.query('CREATE TABLE stale_workflow_queue.executions (LIKE public.executions INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO stale_workflow_queue.executions SELECT * FROM public.executions');
    const plugin = app.pm.get('workflow');
    const instruction = plugin.instructions.get('delay');
    const original = instruction.trigger.bind(instruction);
    let triggered: Promise<void> | undefined;
    const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
      if (cached) job.execution = execution;
      triggered = Promise.resolve(original(job));
      triggered.catch(() => undefined);
      return triggered;
    });
    try {
      await app.start();
      expect(instruction.timers.has(pending.id)).toBe(true);
      const model = app.db.getCollection('executions').model;
      await model.update({ status: EXECUTION_STATUS.CANCELED }, { where: { id: execution.id } });
      expect((await model.findByPk(execution.id)).get('status')).toBe(EXECUTION_STATUS.STARTED);
      expect((await model.findByPk(execution.id, { useMaster: true })).get('status')).toBe(EXECUTION_STATUS.CANCELED);
      await waitForFastAssertion(() => expect(triggered).toBeDefined());
      await triggered;
      await waitForWorkflowIdle(app);
      const status = (await model.findByPk(execution.id, { useMaster: true })).get('status');
      const resultCount = await app.db.getCollection('queuedTenantResults').model.count({
        where: { label },
        useMaster: true,
      });
      expect({ status, resultCount }).toEqual({ status: EXECUTION_STATUS.CANCELED, resultCount: 0 });
    } finally {
      instruction.unload();
      await triggered?.catch(() => undefined);
      await waitForWorkflowIdle(app);
      observe.mockRestore();
    }
  });
});
