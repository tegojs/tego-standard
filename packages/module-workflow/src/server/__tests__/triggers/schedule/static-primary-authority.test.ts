import { createMockServer, type MockServer } from '@tachybase/test';

import { isolatedPostgresDatabase } from '../../../../../../module-tenant/src/server/__tests__/access-control/database';
import { waitForFastAssertion, waitForWorkflowIdle } from '../../utils';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Independent real pools with divergent schemas, not WAL replication.
describe.skipIf(!postgresUrl)('static schedule startup primary authority', () => {
  let app: MockServer;
  let workflow;

  beforeAll(async () => {
    const dedicated = isolatedPostgresDatabase(postgresUrl!);
    const connection = { ...dedicated.options };
    await dedicated.close();
    app = await createMockServer({
      database: {
        ...connection,
        replication: {
          write: connection,
          read: [{ ...connection, dialectOptions: { application_name: 'stale-static-schedule' } }],
        },
      },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
      beforeInstall: async (server) => {
        server.db.sequelize.addHook('afterConnect', async (client, config) => {
          if (config.dialectOptions?.application_name === 'stale-static-schedule')
            await client.query('SET search_path TO stale_static_schedule, public');
        });
      },
    });
    app.db.collection({ name: 'staticAuthorityResults', fields: [{ name: 'label', type: 'string' }] });
    await app.db.sync();
  });

  afterAll(async () => {
    if (!app) return;
    if (workflow) app.pm.get('workflow').toggle(workflow, false);
    await app.db.sequelize.query('DROP SCHEMA IF EXISTS stale_static_schedule CASCADE');
    await app.destroy();
  });

  it('does not restore a primary-disabled static task from an enabled read-pool copy', async () => {
    workflow = await app.db.getRepository('workflows').create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticAuthorityResults', params: { values: { label: 'Current static task' } } },
    });
    await app.stop();
    await app.db.reconnect();
    const due = Math.ceil((Date.now() + 1500) / 1000) * 1000;
    const workflows = app.db.getCollection('workflows').model;
    await workflows.update(
      { enabled: true, config: { mode: 0, startsOn: new Date(due).toISOString() } },
      { where: { id: workflow.id }, hooks: false },
    );
    await app.db.sequelize.query('CREATE SCHEMA stale_static_schedule');
    await app.db.sequelize.query('CREATE TABLE stale_static_schedule.workflows (LIKE public.workflows INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO stale_static_schedule.workflows SELECT * FROM public.workflows');
    await workflows.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
    expect((await workflows.findByPk(workflow.id)).enabled).toBe(true);
    expect((await workflows.findByPk(workflow.id, { useMaster: true })).enabled).toBe(false);

    await app.start();
    expect(Date.now()).toBeLessThan(due);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 300));
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions({ useMaster: true })).toBe(0);
    const results = app.db.getCollection('staticAuthorityResults').model;
    expect(await results.count({ useMaster: true })).toBe(0);

    await app.stop();
    await app.db.reconnect();
    const nextDue = Math.ceil((Date.now() + 1500) / 1000) * 1000;
    await app.db
      .getCollection('workflows')
      .model.update(
        { enabled: true, config: { mode: 0, startsOn: new Date(nextDue).toISOString() } },
        { where: { id: workflow.id }, hooks: false },
      );
    await app.start();
    await waitForFastAssertion(async () => {
      const rows = await app.db.getCollection('staticAuthorityResults').model.findAll({ useMaster: true });
      expect(rows.map((row) => row.get('label'))).toEqual(['Current static task']);
    });
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions({ useMaster: true })).toBe(1);
  });
});
