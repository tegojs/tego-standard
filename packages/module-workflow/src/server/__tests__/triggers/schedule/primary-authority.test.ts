import { createMockServer, type MockServer } from '@tachybase/test';
import type { Transaction } from '@tego/server';

import { withAmbientTransactions } from '../../../../../../module-tenant/src/server/__tests__/access-control/ambient-transactions';
import { isolatedPostgresDatabase } from '../../../../../../module-tenant/src/server/__tests__/access-control/database';
import type WorkflowPlugin from '../../../Plugin';
import type DateFieldScheduleTrigger from '../../../triggers/ScheduleTrigger/DateFieldScheduleTrigger';
import { waitForWorkflowIdle } from '../../utils';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Real independent pools and divergent schemas, not a WAL replica.
describe.skipIf(!postgresUrl)('date-field schedules use primary tenant authority', () => {
  let app: MockServer;
  let workflow;
  let trigger: DateFieldScheduleTrigger;

  beforeAll(async () => {
    // Validate the dedicated local database before the mock server's force install.
    const dedicated = isolatedPostgresDatabase(postgresUrl!);
    const connection = { ...dedicated.options };
    await dedicated.close();
    app = await createMockServer({
      database: {
        ...connection,
        replication: {
          write: connection,
          read: [{ ...connection, dialectOptions: { application_name: 'schedule-stale-tenants' } }],
        },
      },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
      beforeInstall: async (server) => {
        // Run after Database's own hook, which resets search_path to public.
        server.db.sequelize.addHook('afterConnect', async (client, config) => {
          if (config.dialectOptions?.application_name === 'schedule-stale-tenants')
            await client.query('SET search_path TO schedule_stale_tenants, public');
        });
      },
    });
    app.db.collection({
      name: 'tenants',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
        { name: 'path', type: 'string' },
      ],
    });
    for (const name of ['primaryScheduleDocuments', 'primaryScheduleResults']) {
      app.db.collection({
        name,
        tenancy: 'tenantInherited',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'label', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
        ],
      });
    }
    await app.db.sync();
    await app.db.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: true, path: '/B/' },
      { id: 'C', enabled: true, path: '/C/' },
    ]);
    await app.db.sequelize.query('CREATE SCHEMA schedule_stale_tenants');
    await app.db.sequelize.query('CREATE TABLE schedule_stale_tenants.tenants (LIKE public.tenants INCLUDING ALL)');
    await app.db.sequelize.query('INSERT INTO schedule_stale_tenants.tenants SELECT * FROM public.tenants');
    await app.db.sequelize.query(`UPDATE schedule_stale_tenants.tenants SET path='/B/C/' WHERE id='C'`);
    const installed = (app.pm.get('workflow') as WorkflowPlugin).triggers.get('schedule') as unknown as {
      modes: Map<number, DateFieldScheduleTrigger>;
    };
    trigger = installed.modes.get(1)!;
    expect((await app.db.getCollection('tenants').model.findByPk('C'))?.get('path')).toBe('/B/C/');
    expect((await app.db.getCollection('tenants').model.findByPk('C', { useMaster: true }))?.get('path')).toBe('/C/');
  });

  beforeEach(async () => {
    await app.db.getCollection('tenants').model.update({ enabled: true }, { where: { id: 'B' } });
    for (const name of ['primaryScheduleDocuments', 'primaryScheduleResults'])
      await app.db.getCollection(name).model.destroy({ where: {}, hooks: false });
    await app.db
      .getCollection('primaryScheduleDocuments')
      .model.create(
        { id: 1, tenantId: 'B', label: 'Primary owner', scheduledAt: new Date(Date.now() + 60_000) },
        { hooks: false },
      );
    workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'primaryScheduleDocuments', startsOn: { field: 'scheduledAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'primaryScheduleResults', params: { values: { label: 'Generated' } } },
    });
    const initial = vi.spyOn(trigger, 'inspect').mockResolvedValue(undefined);
    try {
      await workflow.update({ enabled: true });
    } finally {
      initial.mockRestore();
    }
  });

  afterEach(async () => {
    await workflow?.update({ enabled: false });
    await waitForWorkflowIdle(app);
  });

  afterAll(async () => {
    if (app) {
      try {
        await app.db.sequelize.query('DROP SCHEMA IF EXISTS schedule_stale_tenants CASCADE');
      } finally {
        await app.destroy();
      }
    }
  });

  async function disablePrimaryOwner() {
    const model = app.db.getCollection('tenants').model;
    await model.update({ enabled: false }, { where: { id: 'B' } });
    expect((await model.findByPk('B'))?.get('enabled')).toBe(true);
    expect((await model.findByPk('B', { useMaster: true }))?.get('enabled')).toBe(false);
  }

  it('excludes an owner disabled on the primary from actual discovery', async () => {
    await disablePrimaryOwner();
    expect(await trigger.loadRecordsToSchedule(workflow, new Date())).toEqual([]);
  });

  it.each([false, true])('does not inherit ambient read-pool authorization (disabled owner: %s)', async (disabled) => {
    if (disabled) await disablePrimaryOwner();
    await withAmbientTransactions(app.db, async () => {
      await app.db.sequelize.transaction({ readOnly: true }, async (transaction) => {
        const [rows] = await app.db.sequelize.query('SELECT current_schema() AS schema', { transaction });
        expect(rows).toEqual([{ schema: 'schedule_stale_tenants' }]);
        expect((await app.db.getCollection('tenants').model.findByPk('C', { transaction }))?.get('path')).toBe('/B/C/');
        const records = await trigger.loadRecordsToSchedule(workflow, new Date());
        if (disabled) {
          expect(records).toEqual([]);
        } else {
          expect(records).toHaveLength(1);
          expect(records[0].__workflowTenantContext.state.currentTenantDescendantIds).toEqual([]);
        }
        expect(transaction.finished).toBeFalsy();
        const [after] = await app.db.sequelize.query('SELECT current_schema() AS schema', { transaction });
        expect(after).toEqual([{ schema: 'schedule_stale_tenants' }]);
      });
    });
  });

  it('does not dispatch a cached record for an owner disabled on the primary', async () => {
    const record = await app.db.getCollection('primaryScheduleDocuments').model.findByPk(1);
    await disablePrimaryOwner();
    await trigger.trigger(workflow, record, Date.now());
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions()).toBe(0);
    expect(await app.db.getCollection('primaryScheduleResults').model.count()).toBe(0);
  });

  it.each(['unbound', 'ambient read pool', 'read-pool transaction', 'read-pool savepoint'])(
    'rejects an obsolete record owner from the read pool (%s)',
    async (mode) => {
      const model = app.db.getCollection('primaryScheduleDocuments').model;
      const cached = await model.findByPk(1);
      let parent: Transaction | undefined;
      let transaction: Transaction | undefined;
      await app.db.sequelize.query(
        'CREATE TABLE schedule_stale_tenants."primaryScheduleDocuments" (LIKE public."primaryScheduleDocuments" INCLUDING ALL)',
      );
      try {
        await app.db.sequelize.query(
          'INSERT INTO schedule_stale_tenants."primaryScheduleDocuments" SELECT * FROM public."primaryScheduleDocuments"',
        );
        // A controlled persisted transition, not permission to reassign ordinary records.
        await model.update({ tenantId: 'C' }, { where: { id: 1 }, hooks: false });
        expect((await model.findByPk(1))?.get('tenantId')).toBe('B');
        expect((await model.findByPk(1, { useMaster: true }))?.get('tenantId')).toBe('C');

        const attempt = async () => {
          await trigger.trigger(workflow, cached, Date.now(), { transaction });
          await waitForWorkflowIdle(app);
          expect(await workflow.countExecutions()).toBe(0);
          expect(await app.db.getCollection('primaryScheduleResults').model.count()).toBe(0);
        };
        if (mode === 'ambient read pool') {
          await withAmbientTransactions(app.db, async () => {
            await app.db.sequelize.transaction({ readOnly: true }, async (ambient) => {
              expect((await model.findByPk(1, { transaction: ambient }))?.get('tenantId')).toBe('B');
              await attempt();
              expect(ambient.finished).toBeFalsy();
            });
          });
        } else {
          if (mode !== 'unbound') {
            parent = await app.db.sequelize.transaction({ readOnly: true });
            transaction =
              mode === 'read-pool savepoint' ? await app.db.sequelize.transaction({ transaction: parent }) : parent;
            expect((await model.findByPk(1, { transaction }))?.get('tenantId')).toBe('B');
          }
          await attempt();
          if (transaction) expect(transaction.finished).toBeFalsy();
        }
        if (transaction && transaction !== parent) await transaction.rollback();
        if (parent) await parent.rollback();
        transaction = undefined;
        parent = undefined;

        const fresh = await model.findByPk(1, { useMaster: true });
        await trigger.trigger(workflow, fresh, Date.now());
        await waitForWorkflowIdle(app);
        const [execution] = await workflow.getExecutions();
        expect(await workflow.countExecutions()).toBe(1);
        expect(execution.tenantId).toBe('C');
        expect(execution.context.data.tenantId).toBe('C');
        const generated = await app.db.getCollection('primaryScheduleResults').model.findAll();
        expect(generated.map((row) => row.get('tenantId'))).toEqual(['C']);
      } finally {
        try {
          if (transaction && transaction !== parent && !transaction.finished) await transaction.rollback();
        } finally {
          if (parent && !parent.finished) await parent.rollback();
          await app.db.sequelize.query('DROP TABLE schedule_stale_tenants."primaryScheduleDocuments"');
        }
      }
    },
  );

  it('preserves an explicit write transaction and sees its uncommitted owner', async () => {
    const model = app.db.getCollection('primaryScheduleDocuments').model;
    const cached = await model.findByPk(1);
    const transaction = await app.db.sequelize.transaction();
    try {
      await model.update({ tenantId: 'C' }, { where: { id: 1 }, hooks: false, transaction });
      await trigger.trigger(workflow, cached, Date.now(), { transaction });
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(transaction.finished).toBeFalsy();
      expect((await model.findByPk(1, { transaction }))?.get('tenantId')).toBe('C');
      expect((await model.findByPk(1, { useMaster: true, transaction: null }))?.get('tenantId')).toBe('B');
    } finally {
      await transaction.rollback();
    }
    const fresh = await model.findByPk(1, { useMaster: true });
    await trigger.trigger(workflow, fresh, Date.now());
    await waitForWorkflowIdle(app);
    const [execution] = await workflow.getExecutions();
    expect(await workflow.countExecutions()).toBe(1);
    expect(execution.tenantId).toBe('B');
    expect(execution.context.data.tenantId).toBe('B');
  });

  it('does not embed an obsolete descendant in the persisted execution context', async () => {
    const record = await app.db.getCollection('primaryScheduleDocuments').model.findByPk(1);
    await trigger.trigger(workflow, record, Date.now());
    await waitForWorkflowIdle(app);
    const [execution] = await workflow.getExecutions();
    expect(execution.tenantId).toBe('B');
    expect(execution.context.state.currentTenantDescendantIds).toEqual([]);
    const generated = await app.db.getCollection('primaryScheduleResults').model.findAll();
    expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
  });

  it('does not schedule a save event using a stale enabled owner', async () => {
    const collection = app.db.getCollection('primaryScheduleDocuments');
    const due = Math.ceil((Date.now() + 500) / 1000) * 1000;
    await collection.model.update({ scheduledAt: new Date(due) }, { where: { id: 1 }, hooks: false });
    const record = await collection.model.findByPk(1);
    await disablePrimaryOwner();
    const original = trigger.trigger.bind(trigger);
    const pending: Promise<unknown>[] = [];
    const dispatch = vi.spyOn(trigger, 'trigger').mockImplementation((...args) => {
      const result = original(...args);
      pending.push(result);
      return result;
    });
    try {
      await app.db.emitAsync('primaryScheduleDocuments.afterSaveWithAssociations', record, {});
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 100));
      await Promise.allSettled(pending);
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getCollection('primaryScheduleResults').model.count()).toBe(0);
    } finally {
      trigger.off(workflow);
      await Promise.allSettled(pending);
      dispatch.mockRestore();
    }
  });
});
