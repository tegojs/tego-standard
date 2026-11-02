import { createMockServer, type MockServer } from '@tachybase/test';
import { mockDatabase, SequelizeDataSource, type Database } from '@tego/server';

import type WorkflowPlugin from '../../../Plugin';
import DateFieldScheduleTrigger from '../../../triggers/ScheduleTrigger/DateFieldScheduleTrigger';
import { waitForWorkflowIdle } from '../../utils';

describe('date-field scheduling from an external database', () => {
  let app: MockServer;
  let external: Database;
  let workflow;
  const now = new Date('2026-11-02T08:00:00.000Z');
  const scheduledAt = new Date(now.getTime() + 60_000);

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    await app.dataSourceManager.add(
      new SequelizeDataSource({ name: 'another', collectionManager: { database: external }, resourceManager: {} }),
    );
    for (const db of [app.db, external]) {
      db.collection({
        name: 'tenants',
        autoGenId: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'enabled', type: 'boolean' },
          { name: 'path', type: 'string' },
        ],
      });
      db.collection({
        name: 'externalScheduleDocuments',
        tenancy: 'tenantScoped',
        fields: [
          { name: 'label', type: 'string' },
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
        ],
      });
      db.collection({
        name: 'externalSharedSchedules',
        tenancy: 'shared',
        fields: [
          { name: 'label', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
        ],
      });
      await db.sync();
    }
    await app.db.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: true, path: '/B/' },
      { id: 'C', enabled: true, path: '/B/C/' },
      { id: 'H', enabled: false, path: '/H/' },
    ]);
    await external.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: false, path: '/foreign/' },
      { id: 'C', enabled: false, path: '/unrelated/' },
      { id: 'H', enabled: true, path: '/foreign/H/' },
    ]);
    for (const name of ['externalScheduleDocuments', 'externalSharedSchedules']) {
      await app.db.getCollection(name).model.create({ id: 1, label: 'Main decoy', scheduledAt });
      await external.getCollection(name).model.bulkCreate([
        { id: 1, label: 'External B', tenantId: 'B', scheduledAt },
        { id: 2, label: 'External H', tenantId: 'H', scheduledAt },
      ]);
    }
  });

  beforeEach(async () => {
    workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'schedule',
        enabled: false,
        config: {
          mode: 1,
          collection: 'another:externalScheduleDocuments',
          startsOn: { field: 'scheduledAt' },
        },
      },
    });
    const installed = (app.pm.get('workflow') as WorkflowPlugin).triggers.get('schedule') as unknown as {
      modes: Map<number, DateFieldScheduleTrigger>;
    };
    const initialScan = vi.spyOn(installed.modes.get(1)!, 'inspect').mockImplementation(() => undefined);
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
    await external?.close();
  });

  it.each(['tenantScoped', 'tenantInherited'])(
    'scans %s rows from the selected source using primary tenant authority',
    async (tenancy) => {
      const collection = external.getCollection('externalScheduleDocuments');
      collection.options.tenancy = tenancy;
      const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
      expect(external.sequelize).not.toBe(app.db.sequelize);
      const rows = await trigger.loadRecordsToSchedule(workflow, now);
      expect(rows.map((row) => [row.get('id'), row.get('label'), row.get('tenantId')])).toEqual([
        [1, 'External B', 'B'],
      ]);
      await trigger.trigger(workflow, rows[0], scheduledAt.getTime());
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution.context.data.label).toBe('External B');
      expect(execution.tenantId).toBe('B');
      expect(execution.tenantContext.currentTenantDescendantIds).toEqual(tenancy === 'tenantInherited' ? ['C'] : []);
    },
  );

  it('scans a shared source without requiring a tenantId column or tenant context', async () => {
    const installed = (app.pm.get('workflow') as WorkflowPlugin).triggers.get('schedule') as unknown as {
      modes: Map<number, DateFieldScheduleTrigger>;
    };
    const initialScan = vi.spyOn(installed.modes.get(1)!, 'inspect').mockImplementation(() => undefined);
    try {
      await workflow.update({ config: { ...workflow.config, collection: 'another:externalSharedSchedules' } });
    } finally {
      initialScan.mockRestore();
    }
    const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
    const rows = await trigger.loadRecordsToSchedule(workflow, now);
    expect(rows.map((row) => row.get('label')).sort()).toEqual(['External B', 'External H']);
    await trigger.trigger(workflow, rows[0], scheduledAt.getTime());
    await waitForWorkflowIdle(app);
    const [execution] = await workflow.getExecutions();
    expect(execution.context.data.label).toMatch(/^External /);
    expect(execution.tenantId).toBeNull();
  });

  it('does not fall back to a same-named main table when the source is missing', async () => {
    const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
    await expect(
      trigger.loadRecordsToSchedule(
        {
          ...workflow.get(),
          config: { ...workflow.config, collection: 'missing:externalScheduleDocuments' },
        },
        now,
      ),
    ).rejects.toThrow();
    expect(await workflow.countExecutions()).toBe(0);
  });
});
