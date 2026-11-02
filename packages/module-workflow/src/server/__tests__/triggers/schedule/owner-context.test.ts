import { createMockServer, type MockServer } from '@tachybase/test';

import { EXECUTION_STATUS } from '../../../constants';
import type WorkflowPlugin from '../../../Plugin';
import type ScheduleTrigger from '../../../triggers/ScheduleTrigger';
import DateFieldScheduleTrigger from '../../../triggers/ScheduleTrigger/DateFieldScheduleTrigger';
import { waitForAssertion, waitForWorkflowIdle } from '../../utils';

describe('date-field schedules retain the record owner', () => {
  let app: MockServer;
  let workflow;

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    app.db.collection({
      name: 'tenants',
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
        { name: 'path', type: 'string' },
      ],
    });
    for (const name of ['scheduledOwnerDocuments', 'scheduledOwnerResults']) {
      app.db.collection({
        name,
        tenancy: 'tenantInherited',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
    }
    app.db.collection({
      name: 'scheduledKeyDocuments',
      tenancy: 'tenantScoped',
      autoGenId: false,
      filterTargetKey: 'documentNo',
      fields: [
        { name: 'documentNo', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    await app.db.sync();
  });

  beforeEach(async () => {
    await app.db.getCollection('tenants').model.destroy({ where: {}, hooks: false });
    await app.db.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: true, path: '/B/' },
      { id: 'H', enabled: true, path: '/B/H/' },
    ]);
    for (const name of ['scheduledOwnerDocuments', 'scheduledOwnerResults', 'scheduledKeyDocuments'])
      await app.db.getCollection(name).model.destroy({ where: {}, hooks: false });
    workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'scheduledOwnerDocuments', startsOn: { field: 'createdAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'scheduledOwnerResults', params: { values: { name: 'Generated' } } },
    });
    // Save-event and explicit discovery tests own their dispatch boundaries.
    const initialScan = vi.spyOn(DateFieldScheduleTrigger.prototype, 'inspect').mockImplementation(() => undefined);
    try {
      await workflow.update({ enabled: true });
    } finally {
      initialScan.mockRestore();
    }
  });

  afterEach(async () => {
    await workflow?.update({ enabled: false });
    await waitForWorkflowIdle(app);
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const caller = {
    state: {
      currentTenantId: 'B',
      currentTenant: { id: 'B' },
      currentTenantDescendantIds: ['H'],
      currentTenancyMode: 'tenantInherited',
      currentRole: 'root',
      currentUser: { id: 99 },
    },
  };

  async function saveAsAncestor() {
    return app.db.getRepository('scheduledOwnerDocuments').create({
      values: { name: 'Child-owned document', tenantId: 'H' },
      context: caller,
    });
  }

  it.each(['tenantScoped', 'tenantInherited'])(
    'persists %s executions and generated data under the owner rather than the saving ancestor',
    async (tenancy) => {
      app.db.getCollection('scheduledOwnerDocuments').options.tenancy = tenancy;
      const record = await saveAsAncestor();
      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution?.status).toBe(EXECUTION_STATUS.RESOLVED);
      });
      const [execution] = await workflow.getExecutions();
      expect(execution.context.data.id).toBe(record.get('id'));
      expect(execution.tenantId).toBe('H');
      expect(execution.tenantContext.currentTenantId).toBe('H');
      expect(execution.context.state.currentTenantId).toBe('H');
      expect(execution.get('authContext')).toBeNull();
      const generated = await app.db.getCollection('scheduledOwnerResults').model.findAll();
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['H']);
      expect((await record.reload()).get('tenantId')).toBe('H');
      expect(caller.state.currentTenantId).toBe('B');
    },
  );

  it('does not dispatch a disabled owner through an enabled saving ancestor', async () => {
    await app.db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'H' } });
    const record = await saveAsAncestor();
    // Await the actual installed listener as well as draining the asynchronous workflow queue.
    await app.db.emitAsync('scheduledOwnerDocuments.afterSaveWithAssociations', record, { context: caller });
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions()).toBe(0);
    expect(await app.db.getCollection('scheduledOwnerResults').model.count()).toBe(0);
  });

  it.each([
    { collection: 'scheduledOwnerDocuments', key: 'id' },
    { collection: 'scheduledKeyDocuments', key: 'documentNo' },
  ])(
    'dispatches different owners at the same instant using $key and suppresses a repeated record',
    async ({ collection, key }) => {
      // Keep the ordinary cache outside this test's immediate dispatch window.
      await workflow.update({
        config: { ...workflow.config, collection, startsOn: { field: 'createdAt', offset: 86400 } },
      });
      const records = await app.db.getCollection(collection).model.bulkCreate(
        [
          { [key]: 0, name: 'Ancestor-owned', tenantId: 'B' },
          { [key]: 1, name: 'Child-owned', tenantId: 'H' },
          { [key]: 2, name: 'Another child-owned document', tenantId: 'H' },
        ],
        { hooks: false },
      );
      const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
      const instant = new Date('2026-11-01T00:00:00.000Z').getTime();
      for (const record of [...records, records[0]]) {
        await trigger.trigger(workflow, record, instant);
        await waitForWorkflowIdle(app);
      }
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions.map((row) => [row.context.data[key], row.tenantId])).toEqual(
        records.map((row) => [row.get(key), row.get('tenantId')]),
      );
      const generated = await app.db.getCollection('scheduledOwnerResults').model.findAll({ order: [['id', 'ASC']] });
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['B', 'H', 'H']);
    },
  );

  it('rejects date-field events without the configured record identity', async () => {
    const trigger = (app.pm.get('workflow') as WorkflowPlugin).triggers.get('schedule') as ScheduleTrigger;
    const date = new Date('2026-11-01T00:00:00.000Z');
    expect(await trigger.validateEvent(workflow, { date }, {})).toBe(false);
    expect(await trigger.validateEvent(workflow, { date, data: { id: null } }, {})).toBe(false);
    expect(await workflow.countExecutions()).toBe(0);
  });

  it('rejects a cached legacy schedule after the persisted record has acquired another owner', async () => {
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    plugin.triggers.get('schedule')!.off(workflow);
    const collection = app.db.getCollection('scheduledOwnerDocuments');
    const originalLegacy = collection.options.legacyDataTenantIds;
    collection.options.legacyDataTenantIds = ['B'];
    try {
      const now = new Date();
      const instant = now.getTime() + 1000;
      const record = await collection.model.create(
        { name: 'Initially unassigned', tenantId: null, createdAt: new Date(instant) },
        { hooks: false },
      );
      const trigger = new DateFieldScheduleTrigger(plugin);
      const [cached] = await trigger.loadRecordsToSchedule(workflow, now);
      expect(cached.get('id')).toBe(record.get('id'));
      expect(cached.get('tenantId')).toBeNull();

      // A completed ownership change after discovery, before the due-time Repository read.
      await collection.model.update({ tenantId: 'H' }, { where: { id: record.get('id') }, hooks: false });
      await trigger.trigger(workflow, cached, instant);
      await waitForWorkflowIdle(app);
      const staleExecutions = await workflow.getExecutions();
      const staleGenerated = await app.db.getCollection('scheduledOwnerResults').model.findAll();
      expect({
        executions: staleExecutions.map((row) => [row.tenantId, row.context.data.tenantId]),
        generated: staleGenerated.map((row) => row.get('tenantId')),
      }).toEqual({ executions: [], generated: [] });
      expect((await record.reload()).get('tenantId')).toBe('H');

      const [fresh] = await trigger.loadRecordsToSchedule(workflow, now);
      expect(fresh.get('tenantId')).toBe('H');
      await trigger.trigger(workflow, fresh, instant);
      await waitForWorkflowIdle(app);
      const executions = await workflow.getExecutions();
      expect(executions.map((row) => row.tenantId)).toEqual(['H']);
      const generated = await app.db.getCollection('scheduledOwnerResults').model.findAll();
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['H']);
    } finally {
      collection.options.legacyDataTenantIds = originalLegacy;
    }
  });
});
