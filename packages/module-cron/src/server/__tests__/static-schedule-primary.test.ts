import { PluginWorkflow } from '@tachybase/module-workflow';
import { createMockServer, type MockServer } from '@tachybase/test';

import { withAmbientTransactions } from '../../../../module-tenant/src/server/__tests__/access-control/ambient-transactions';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { waitForFastAssertion } from '../../../../module-workflow/src/server/__tests__/utils';
import cronJobs from '../../collections/cronJobs';
import { CronJobModel } from '../model/CronJobModel';
import { CronJobLock } from '../service/CronJobLock';
import { StaticScheduleTrigger } from '../service/StaticScheduleTrigger';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Real independent pools with divergent schemas, not WAL replication.
describe.skipIf(!postgresUrl)('cron primary enabled authority', () => {
  let app: MockServer;
  let service: StaticScheduleTrigger;
  let lock: CronJobLock;

  beforeAll(async () => {
    const dedicated = isolatedPostgresDatabase(postgresUrl!);
    const connection = { ...dedicated.options };
    await dedicated.close();
    app = await createMockServer({
      database: {
        ...connection,
        replication: {
          write: connection,
          read: [{ ...connection, dialectOptions: { application_name: 'cron-stale-enabled' } }],
        },
      },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [PluginWorkflow, { name: 'workflow', packageName: '@tachybase/module-workflow' }],
      ],
      beforeInstall: async (server) => {
        server.db.sequelize.addHook('afterConnect', async (client, config) => {
          if (config.dialectOptions?.application_name === 'cron-stale-enabled')
            await client.query('SET search_path TO cron_stale_enabled, public');
        });
      },
    });
    app.db.registerModels({ CronJobModel });
    app.db.collection(cronJobs);
    app.db.collection({ name: 'primaryCronSource', tenancy: 'shared', fields: [] });
    app.db.collection({
      name: 'primaryCronResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'label', type: 'string' },
      ],
    });
    app.db.collection({
      name: 'tenants',
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
        { name: 'parentId', type: 'string' },
      ],
    });
    await app.db.sync();
    await app.db.getRepository('tenants').create({ values: { id: 'B', enabled: true } });
    await app.db.sequelize.query('CREATE SCHEMA cron_stale_enabled');
    await app.db.sequelize.query('CREATE TABLE cron_stale_enabled."cronJobs" (LIKE public."cronJobs" INCLUDING ALL)');
    await app.db.sequelize.query('CREATE TABLE cron_stale_enabled.tenants (LIKE public.tenants INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO cron_stale_enabled.tenants SELECT * FROM public.tenants');
    lock = new CronJobLock();
    Object.assign(lock, { app, logger: app.logger });
    await lock.load();
    service = new StaticScheduleTrigger();
    Object.assign(service, { app, db: app.db, logger: app.logger, cronJobLock: lock });
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await app.db.sequelize.query('DROP SCHEMA IF EXISTS cron_stale_enabled CASCADE');
    } finally {
      await app.destroy();
    }
  });

  async function createJob(label: string) {
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', enabled: true, config: { collection: 'primaryCronSource', mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'primaryCronResults', params: { values: { label } } },
    });
    const job = await app.db.getRepository('cronJobs').create({
      values: { name: label, workflowKey: workflow.key, startsOn: new Date(), mode: 0, repeat: '', enabled: true },
    });
    await app.db.sequelize.query(
      'INSERT INTO cron_stale_enabled."cronJobs" SELECT * FROM public."cronJobs" WHERE id=:id',
      { replacements: { id: job.id } },
    );
    return { workflow, job };
  }

  async function idle() {
    const plugin = app.pm.get('workflow');
    await waitForFastAssertion(() => {
      expect(plugin.events).toHaveLength(0);
      expect(plugin.preparing).toBeFalsy();
      expect(plugin.pending).toHaveLength(0);
      expect(plugin.executing).toBeFalsy();
    });
  }

  it.each([false, true])(
    'rejects a primary-disabled job despite a stale enabled read (ambient: %s)',
    async (ambient) => {
      const label = `Primary cron ${ambient}`;
      const { workflow, job } = await createJob(label);
      const model = app.db.getModel('cronJobs');
      await model.update({ enabled: false }, { where: { id: job.id }, hooks: false });
      expect((await model.findByPk(job.id)).get('enabled')).toBe(true);
      expect((await model.findByPk(job.id, { useMaster: true, transaction: null })).get('enabled')).toBe(false);
      const time = Math.floor(Date.now() / 1000) * 1000;
      try {
        if (ambient) {
          await withAmbientTransactions(app.db, async () => {
            await app.db.sequelize.transaction({ readOnly: true }, async (transaction) => {
              expect((await model.findByPk(job.id, { transaction })).get('enabled')).toBe(true);
              await service.trigger(job.id, time);
              expect(transaction.finished).toBeFalsy();
            });
          });
        } else {
          await service.trigger(job.id, time);
        }
        await idle();
        expect(await workflow.countExecutions({ useMaster: true, transaction: null })).toBe(0);
        expect(
          await app.db.getModel('primaryCronResults').count({ where: { label }, useMaster: true, transaction: null }),
        ).toBe(0);
        expect(await lock.isLocked(job.id, time)).toBe(false);

        await model.update({ enabled: true }, { where: { id: job.id }, hooks: false });
        await service.trigger(job.id, time);
        await waitForFastAssertion(async () => {
          const executions = await workflow.getExecutions({ useMaster: true, transaction: null });
          expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
          const rows = await app.db
            .getModel('primaryCronResults')
            .findAll({ where: { label }, useMaster: true, transaction: null });
          expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', label]]);
        });
      } finally {
        service.off(job);
        await workflow.update({ enabled: false });
        await idle();
      }
    },
  );

  it.each([false, true])(
    'does not dispatch an owner disabled on primary despite stale tenant facts (ambient: %s)',
    async (ambient) => {
      const label = `Primary tenant ${ambient}`;
      const { workflow, job } = await createJob(label);
      const tenants = app.db.getModel('tenants');
      await tenants.update({ enabled: false }, { where: { id: 'B' }, hooks: false });
      expect((await tenants.findByPk('B')).get('enabled')).toBe(true);
      expect((await tenants.findByPk('B', { useMaster: true, transaction: null })).get('enabled')).toBe(false);
      const time = Math.floor(Date.now() / 1000) * 1000;
      try {
        if (ambient) {
          await withAmbientTransactions(app.db, async () => {
            await app.db.sequelize.transaction({ readOnly: true }, async (transaction) => {
              expect((await tenants.findByPk('B', { transaction })).get('enabled')).toBe(true);
              await service.trigger(job.id, time);
              expect(transaction.finished).toBeFalsy();
            });
          });
        } else {
          await service.trigger(job.id, time);
        }
        await idle();
        expect(await workflow.countExecutions({ useMaster: true, transaction: null })).toBe(0);
        expect(
          await app.db.getModel('primaryCronResults').count({ where: { label }, useMaster: true, transaction: null }),
        ).toBe(0);
        expect(await lock.isLocked(job.id, time)).toBe(false);

        await tenants.update({ enabled: true }, { where: { id: 'B' }, hooks: false });
        await service.trigger(job.id, time);
        await waitForFastAssertion(async () => {
          const executions = await workflow.getExecutions({ useMaster: true, transaction: null });
          expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
          const rows = await app.db
            .getModel('primaryCronResults')
            .findAll({ where: { label }, useMaster: true, transaction: null });
          expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', label]]);
        });
      } finally {
        await tenants.update({ enabled: true }, { where: { id: 'B' }, hooks: false });
        service.off(job);
        await workflow.update({ enabled: false });
        await idle();
      }
    },
  );
  it('discovers tenant work from primary nodes missing from the read pool', async () => {
    const label = 'Primary node tenant work';
    const { workflow, job } = await createJob(label);
    await app.db.sequelize.query('CREATE TABLE cron_stale_enabled.flow_nodes (LIKE public.flow_nodes INCLUDING ALL)');
    try {
      expect(await workflow.getNodes()).toHaveLength(0);
      const nodes = await workflow.getNodes({ useMaster: true, transaction: null });
      expect(nodes.map((node) => node.config.collection)).toEqual(['primaryCronResults']);
      const time = Math.floor(Date.now() / 1000) * 1000;
      await service.trigger(job.id, time);
      await idle();
      const executions = await workflow.getExecutions({ useMaster: true, transaction: null });
      expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
      expect(executions.map((execution) => execution.tenantContext.currentTenantId)).toEqual(['B']);
      const rows = await app.db
        .getModel('primaryCronResults')
        .findAll({ where: { label }, useMaster: true, transaction: null });
      expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', label]]);
      expect(await lock.isLocked(job.id, time)).toBe(false);
      const persisted = await app.db.getRepository('cronJobs').findOne({
        filterByTk: job.id,
        useMaster: true,
        transaction: null,
      });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
    } finally {
      service.off(job);
      await workflow.update({ enabled: false });
      await idle();
      await app.db.sequelize.query('DROP TABLE cron_stale_enabled.flow_nodes');
    }
  });
});
