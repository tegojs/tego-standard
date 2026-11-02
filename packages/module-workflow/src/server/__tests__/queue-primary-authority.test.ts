import { createMockServer, type MockServer } from '@tachybase/test';

import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { EXECUTION_STATUS } from '../constants';
import { waitForWorkflowIdle } from './utils';

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
    expect(await model.count()).toBe(0);
    expect(await model.count({ useMaster: true })).toBe(2);
    await app.start();
    await waitForWorkflowIdle(app);
    const statuses = [];
    for (const execution of executions) {
      await execution.reload({ useMaster: true });
      statuses.push(execution.status);
    }
    expect(statuses).toEqual([EXECUTION_STATUS.RESOLVED, EXECUTION_STATUS.RESOLVED]);
    const results = await app.db.getCollection('queuedTenantResults').model.findAll({
      useMaster: true,
      order: [['id', 'ASC']],
    });
    expect(results.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([
      ['B', 'Recovered owner task'],
      ['H', 'Recovered owner task'],
    ]);
  });
});
