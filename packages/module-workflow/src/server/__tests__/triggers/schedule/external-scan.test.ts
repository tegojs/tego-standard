import { createMockServer, type MockServer } from '@tachybase/test';
import { mockDatabase, SequelizeDataSource, type Database } from '@tego/server';

import type WorkflowPlugin from '../../../Plugin';
import DateFieldScheduleTrigger from '../../../triggers/ScheduleTrigger/DateFieldScheduleTrigger';
import { waitForAssertion, waitForWorkflowIdle } from '../../utils';

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
    const initialScan = vi.spyOn(installed.modes.get(1)!, 'inspect').mockResolvedValue(undefined);
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

  function installedDateTrigger() {
    const installed = (app.pm.get('workflow') as WorkflowPlugin).triggers.get('schedule') as unknown as {
      modes: Map<number, DateFieldScheduleTrigger>;
    };
    return installed.modes.get(1)!;
  }

  it.each([
    { field: 'order', column: 'order' },
    { field: 'scheduledAt', column: 'scheduled_at' },
  ])('discovers daily schedules using physical column $column for date field $field', async ({ field, column }) => {
    const collection = external.collection({
      name: `externalDateColumn_${column}`,
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: field, type: 'date', field: column },
      ],
    });
    await external.sync();
    const trigger = installedDateTrigger();
    const results = app.db.getCollection('externalScheduleDocuments').model;
    const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    const config = {
      ...workflow.config,
      collection: `another:${collection.name}`,
      startsOn: { field },
      repeat: 86_400_000,
    };
    await workflow.createNode({
      type: 'create',
      config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Keyword date task' } } },
    });
    try {
      await app.db.getModel('workflows').update({ config }, { where: { id: workflow.id }, hooks: false });
      await collection.model.create({ tenantId: 'B', [field]: new Date(due - 86_400_000) }, { hooks: false });
      const current = await app.db.getRepository('workflows').findOne({ filterByTk: workflow.id });
      expect(
        (await trigger.loadRecordsToSchedule(current, new Date())).map((record) => record.get('tenantId')),
      ).toEqual(['B']);
      expect(Date.now()).toBeLessThan(due);
      await observeThroughDeadline(trigger, due, () => trigger.reload());
      const plugin = app.pm.get('workflow');
      await waitForAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual([
        ['B', due],
      ]);
      expect(Date.parse(executions[0].context.data[field])).toBe(due - 86_400_000);
      const generated = await results.findAll({ where: { label: 'Keyword date task' } });
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
      await workflow.reload();
      expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
    } finally {
      trigger.off(workflow);
      await results.destroy({ where: { label: 'Keyword date task' }, hooks: false });
    }
  });

  it.each([
    { endType: 'date', beforeStart: false },
    { endType: 'field', beforeStart: false },
    { endType: 'date', beforeStart: true },
    { endType: 'field', beforeStart: true },
  ])(
    'discovers a first start with $endType end time (end before start: $beforeStart)',
    async ({ endType, beforeStart }) => {
      const collection = external.collection({
        name: `externalEndWindow_${endType}_${beforeStart}`,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
          { name: 'endsAt', type: 'date' },
        ],
      });
      await external.sync();
      const trigger = installedDateTrigger();
      const results = app.db.getCollection('externalScheduleDocuments').model;
      const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
      const end = due + (beforeStart ? -1000 : 3_600_000);
      const config = {
        ...workflow.config,
        collection: `another:${collection.name}`,
        repeat: 86_400_000,
        endsOn: endType === 'date' ? new Date(end).toISOString() : { field: 'endsAt' },
      };
      await workflow.createNode({
        type: 'create',
        config: { collection: 'externalScheduleDocuments', params: { values: { label: 'End window task' } } },
      });
      try {
        await app.db.getModel('workflows').update({ config }, { where: { id: workflow.id }, hooks: false });
        await collection.model.create(
          { tenantId: 'B', scheduledAt: new Date(due), endsAt: new Date(end) },
          { hooks: false },
        );
        const current = await app.db.getRepository('workflows').findOne({ filterByTk: workflow.id });
        expect(
          (await trigger.loadRecordsToSchedule(current, new Date())).map((record) => record.get('tenantId')),
        ).toEqual(['B']);
        expect(Date.now()).toBeLessThan(due - 1000);
        await observeThroughDeadline(trigger, due, () => trigger.reload());
        const plugin = app.pm.get('workflow');
        await waitForAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
          beforeStart ? [] : [['B', due]],
        );
        const generated = await results.findAll({ where: { label: 'End window task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(beforeStart ? [] : ['B']);
        await workflow.reload();
        expect([workflow.executed, workflow.allExecuted]).toEqual(beforeStart ? [0, 0] : [1, 1]);
      } finally {
        trigger.off(workflow);
        await results.destroy({ where: { label: 'End window task' }, hooks: false });
      }
    },
  );

  it.each([
    { endType: 'date', beforeStart: true },
    { endType: 'field', beforeStart: true },
    { endType: 'date', beforeStart: false },
    { endType: 'field', beforeStart: false },
  ])(
    'checks $endType end time when a real save is delivered in the next second (end before start: $beforeStart)',
    async ({ endType, beforeStart }) => {
      const collection = external.collection({
        name: `externalDelayedSave_${endType}_${beforeStart}`,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'endsAt', type: 'date' },
        ],
      });
      await external.sync();
      const end = Date.now() + (beforeStart ? -5000 : 3_600_000);
      const trigger = installedDateTrigger();
      const results = app.db.getCollection('externalScheduleDocuments').model;
      await workflow.createNode({
        type: 'create',
        config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Delayed save task' } } },
      });
      await workflow.update({
        config: {
          mode: 1,
          collection: `another:${collection.name}`,
          startsOn: { field: 'createdAt' },
          endsOn: endType === 'date' ? new Date(end).toISOString() : { field: 'endsAt' },
        },
      });
      let savedSecond: number;
      const delayDelivery = async (record) => {
        savedSecond = Math.floor(record.get('updatedAt').getTime() / 1000) * 1000;
        expect(Math.floor(record.get('createdAt').getTime() / 1000) * 1000).toBe(savedSecond);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, savedSecond + 1050 - Date.now())));
        expect(Date.now()).toBeGreaterThanOrEqual(savedSecond + 1000);
      };
      const event = `${collection.name}.afterCreateWithAssociations`;
      external.on(event, delayDelivery);
      try {
        const record = await collection.repository.create({ values: { tenantId: 'B', endsAt: new Date(end) } });
        expect(record.get('tenantId')).toBe('B');
        expect(Date.now()).toBeGreaterThanOrEqual(savedSecond! + 1000);
        const plugin = app.pm.get('workflow');
        await waitForAssertion(async () => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
          const executions = await workflow.getExecutions();
          expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
            beforeStart ? [] : [['B', savedSecond]],
          );
        });
        const generated = await results.findAll({ where: { label: 'Delayed save task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(beforeStart ? [] : ['B']);
        await workflow.reload();
        expect([workflow.executed, workflow.allExecuted]).toEqual(beforeStart ? [0, 0] : [1, 1]);
      } finally {
        external.off(event, delayDelivery);
        trigger.off(workflow);
        await results.destroy({ where: { label: 'Delayed save task' }, hooks: false });
      }
    },
  );

  it('bounds daily repeat discovery while retaining future first starts and start offsets', async () => {
    const trigger = installedDateTrigger();
    const documents = external.getCollection('externalScheduleDocuments').model;
    const offset = 60;
    try {
      await documents.update(
        { scheduledAt: new Date(now.getTime() + 60_000 - offset * 1000) },
        { where: { id: 1 }, hooks: false },
      );
      await documents.bulkCreate([
        { id: 3, tenantId: 'B', scheduledAt: new Date(now.getTime() - 86_400_000 + 60_000 - offset * 1000) },
        { id: 4, tenantId: 'B', scheduledAt: new Date(now.getTime() - 3_600_000 - offset * 1000) },
        { id: 5, tenantId: 'B', scheduledAt: new Date(now.getTime() + 3_600_000 - offset * 1000) },
        { id: 6, tenantId: 'B', scheduledAt: new Date(now.getTime() - offset * 1000) },
      ]);
      const current = await app.db.getRepository('workflows').findOne({ filterByTk: workflow.id });
      current.set('config', {
        ...current.config,
        startsOn: { field: 'scheduledAt', offset, unit: 1000 },
        repeat: 86_400_000,
      });
      const records = await trigger.loadRecordsToSchedule(current, new Date(now.getTime() + 500));
      expect(records.map((record) => record.get('id')).sort()).toEqual([1, 3, 6]);
    } finally {
      await documents.update({ scheduledAt }, { where: { id: 1 }, hooks: false });
      await documents.destroy({ where: { id: [3, 4, 5, 6] }, hooks: false });
    }
  });

  it.each([0, 60, -60])('discovers the next daily occurrence with a start offset of %s seconds', async (offset) => {
    const trigger = installedDateTrigger();
    const documents = external.getCollection('externalScheduleDocuments').model;
    const results = app.db.getCollection('externalScheduleDocuments').model;
    const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    const startsOn = { field: 'scheduledAt', offset, unit: 1000 };
    const config = { ...workflow.config, startsOn, repeat: 86400000 };
    await workflow.createNode({
      type: 'create',
      config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Daily external task' } } },
    });
    try {
      await app.db.getModel('workflows').update({ config }, { where: { id: workflow.id }, hooks: false });
      await documents.update({ scheduledAt: new Date(due - 86400000 - offset * 1000) }, { where: {}, hooks: false });
      const current = await app.db.getRepository('workflows').findOne({ filterByTk: workflow.id });
      const record = await documents.findByPk(1);
      expect(trigger.getRecordNextTime(current, record, false, new Date(due - 2000))).toBe(due);
      expect(Date.now()).toBeLessThan(due);
      await observeThroughDeadline(trigger, due, () => trigger.reload());
      const plugin = app.pm.get('workflow');
      await waitForAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual([
        ['B', due],
      ]);
      expect(executions[0].context.data.label).toBe('External B');
      expect(executions[0].context.data.tenantId).toBe('B');
      const generated = await results.findAll({ where: { label: 'Daily external task' } });
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
      await workflow.reload();
      expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
    } finally {
      trigger.off(workflow);
      await documents.update({ scheduledAt }, { where: {}, hooks: false });
      await results.destroy({ where: { label: 'Daily external task' }, hooks: false });
    }
  });

  it.each([
    { repeat: 86_400_000, expired: false },
    { repeat: 86_400_000, expired: true },
    { repeat: '*/2 * * * * *', expired: false },
    { repeat: '*/2 * * * * *', expired: true },
  ])('discovers schedules with a custom end date (repeat: $repeat, expired: $expired)', async ({ repeat, expired }) => {
    const trigger = installedDateTrigger();
    const documents = external.getCollection('externalScheduleDocuments').model;
    const results = app.db.getCollection('externalScheduleDocuments').model;
    const due = Math.ceil((Date.now() + 3000) / 2000) * 2000;
    const config = {
      ...workflow.config,
      repeat,
      endsOn: new Date(expired ? Date.now() - 5000 : due).toISOString(),
    };
    await workflow.createNode({
      type: 'create',
      config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Custom end task' } } },
    });
    try {
      await app.db.getModel('workflows').update({ config }, { where: { id: workflow.id }, hooks: false });
      await documents.update(
        { scheduledAt: new Date(typeof repeat === 'number' ? due - repeat : due) },
        { where: {}, hooks: false },
      );
      const current = await app.db.getRepository('workflows').findOne({ filterByTk: workflow.id });
      const record = await documents.findByPk(1);
      expect(trigger.getRecordNextTime(current, record, false, new Date(due - 2000))).toBe(expired ? null : due);
      expect(Date.now()).toBeLessThan(due);
      await observeThroughDeadline(trigger, due, () => trigger.reload());
      const plugin = app.pm.get('workflow');
      await waitForAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
        expired ? [] : [['B', due]],
      );
      const generated = await results.findAll({ where: { label: 'Custom end task' } });
      expect(generated.map((row) => row.get('tenantId'))).toEqual(expired ? [] : ['B']);
      await workflow.reload();
      expect([workflow.executed, workflow.allExecuted]).toEqual(expired ? [0, 0] : [1, 1]);
    } finally {
      trigger.off(workflow);
      await documents.update({ scheduledAt }, { where: {}, hooks: false });
      await results.destroy({ where: { label: 'Custom end task' }, hooks: false });
    }
  });

  it.each([true, false])(
    'rechecks a cached source after another writer clears its start date: %s',
    async (clearStart) => {
      const trigger = installedDateTrigger();
      const model = external.getCollection('externalScheduleDocuments').model;
      const results = app.db.getCollection('externalScheduleDocuments').model;
      const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
      await workflow.createNode({
        type: 'create',
        config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Cleared start task' } } },
      });
      try {
        await model.update({ scheduledAt: new Date(due) }, { where: { id: 1 }, hooks: false });
        await observeThroughDeadline(trigger, due, async () => {
          await trigger.reload();
          await model.update(
            { scheduledAt: clearStart ? null : new Date(due), label: 'Changed by another writer' },
            { where: { id: 1 }, hooks: false },
          );
          expect(Date.now()).toBeLessThan(due);
        });
        const plugin = app.pm.get('workflow');
        await waitForAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
          clearStart ? [] : [['B', due]],
        );
        expect((await model.findByPk(1)).get('scheduledAt')?.getTime() ?? null).toBe(clearStart ? null : due);
        if (clearStart) {
          expect(await results.count({ where: { label: 'Cleared start task' } })).toBe(0);
          await workflow.reload();
          expect([workflow.executed, workflow.allExecuted]).toEqual([0, 0]);
          const nextDue = Math.ceil((Date.now() + 2000) / 1000) * 1000;
          await model.update({ scheduledAt: new Date(nextDue) }, { where: { id: 1 }, hooks: false });
          await observeThroughDeadline(trigger, nextDue, () => trigger.reload());
          await waitForAssertion(async () => {
            expect(await workflow.countExecutions()).toBe(1);
            expect(plugin.events).toHaveLength(0);
            expect(plugin.preparing).toBeFalsy();
            expect(plugin.pending).toHaveLength(0);
            expect(plugin.executing).toBeFalsy();
          });
          const [execution] = await workflow.getExecutions();
          expect([execution.tenantId, Date.parse(execution.context.date)]).toEqual(['B', nextDue]);
        } else {
          expect(executions[0].context.data.label).toBe('Changed by another writer');
        }
        const generated = await results.findAll({ where: { label: 'Cleared start task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
        await workflow.reload();
        expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
      } finally {
        trigger.off(workflow);
        await model.update({ scheduledAt, label: 'External B' }, { where: { id: 1 }, hooks: false });
        await results.destroy({ where: { label: 'Cleared start task' }, hooks: false });
      }
    },
  );

  it.each([true, false])(
    'rechecks a repeated occurrence after another writer changes its end date (ends before due: %s)',
    async (endsBeforeDue) => {
      const collection = external.collection({
        name: `externalCurrentEnd_${endsBeforeDue}`,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
          { name: 'endsAt', type: 'date' },
        ],
      });
      await external.sync();
      const trigger = installedDateTrigger();
      const results = app.db.getCollection('externalScheduleDocuments').model;
      const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
      await workflow.createNode({
        type: 'create',
        config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Current end task' } } },
      });
      try {
        await app.db.getModel('workflows').update(
          {
            config: {
              ...workflow.config,
              collection: `another:${collection.name}`,
              repeat: 86_400_000,
              endsOn: { field: 'endsAt' },
            },
          },
          { where: { id: workflow.id }, hooks: false },
        );
        const record = await collection.model.create(
          { tenantId: 'B', scheduledAt: new Date(due - 86_400_000), endsAt: new Date(due + 3_600_000) },
          { hooks: false },
        );
        const end = due + (endsBeforeDue ? -1000 : 0);
        await observeThroughDeadline(trigger, due, async () => {
          await trigger.reload();
          await collection.model.update({ endsAt: new Date(end) }, { where: { id: record.id }, hooks: false });
          expect(record.get('endsAt').getTime()).toBe(due + 3_600_000);
          expect(Date.now()).toBeLessThan(due - 1000);
        });
        const plugin = app.pm.get('workflow');
        await waitForAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
          endsBeforeDue ? [] : [['B', due]],
        );
        expect((await record.reload()).get('endsAt').getTime()).toBe(end);
        if (endsBeforeDue) {
          expect(await results.count({ where: { label: 'Current end task' } })).toBe(0);
          await workflow.reload();
          expect([workflow.executed, workflow.allExecuted]).toEqual([0, 0]);
          const nextDue = Math.ceil((Date.now() + 2000) / 1000) * 1000;
          await collection.model.update(
            { scheduledAt: new Date(nextDue - 86_400_000), endsAt: new Date(nextDue) },
            { where: { id: record.id }, hooks: false },
          );
          await observeThroughDeadline(trigger, nextDue, () => trigger.reload());
          await waitForAssertion(async () => {
            expect(plugin.events).toHaveLength(0);
            expect(plugin.preparing).toBeFalsy();
            expect(plugin.pending).toHaveLength(0);
            expect(plugin.executing).toBeFalsy();
            expect(await workflow.countExecutions()).toBe(1);
          });
          const [execution] = await workflow.getExecutions();
          expect([execution.tenantId, Date.parse(execution.context.date)]).toEqual(['B', nextDue]);
        } else {
          expect(Date.parse(executions[0].context.data.endsAt)).toBe(due);
        }
        const generated = await results.findAll({ where: { label: 'Current end task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
        await workflow.reload();
        expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
      } finally {
        trigger.off(workflow);
        await results.destroy({ where: { label: 'Current end task' }, hooks: false });
      }
    },
  );

  it.each([true, false])(
    'rechecks the persisted workflow end after discovery (ends before due: %s)',
    async (endsBeforeDue) => {
      const collection = external.collection({
        name: `externalWorkflowEnd_${endsBeforeDue}`,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
        ],
      });
      await external.sync();
      const trigger = installedDateTrigger();
      const results = app.db.getCollection('externalScheduleDocuments').model;
      const workflows = app.db.getModel('workflows');
      const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
      const initialEnd = new Date(due + 3_600_000).toISOString();
      const config = {
        ...workflow.config,
        collection: `another:${collection.name}`,
        repeat: 86_400_000,
        endsOn: initialEnd,
      };
      await workflow.createNode({
        type: 'create',
        config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Current workflow end task' } } },
      });
      try {
        await workflows.update({ config }, { where: { id: workflow.id }, hooks: false });
        const record = await collection.model.create(
          { tenantId: 'B', scheduledAt: new Date(due - 86_400_000) },
          { hooks: false },
        );
        const currentEnd = new Date(due + (endsBeforeDue ? -1000 : 0)).toISOString();
        await observeThroughDeadline(trigger, due, async () => {
          await trigger.reload();
          await workflows.update(
            { config: { ...config, endsOn: currentEnd } },
            { where: { id: workflow.id }, hooks: false },
          );
          expect(Date.now()).toBeLessThan(due - 1000);
        });
        const plugin = app.pm.get('workflow');
        await waitForAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
          endsBeforeDue ? [] : [['B', due]],
        );
        await workflow.reload({ useMaster: true, transaction: null });
        expect(workflow.config.endsOn).toBe(currentEnd);
        if (endsBeforeDue) {
          expect(await results.count({ where: { label: 'Current workflow end task' } })).toBe(0);
          expect([workflow.executed, workflow.allExecuted]).toEqual([0, 0]);
          const nextDue = Math.ceil((Date.now() + 2000) / 1000) * 1000;
          await collection.model.update(
            { scheduledAt: new Date(nextDue - 86_400_000) },
            { where: { id: record.id }, hooks: false },
          );
          await workflows.update(
            { config: { ...config, endsOn: new Date(nextDue).toISOString() } },
            { where: { id: workflow.id }, hooks: false },
          );
          await observeThroughDeadline(trigger, nextDue, () => trigger.reload());
          await waitForAssertion(async () => {
            expect(plugin.events).toHaveLength(0);
            expect(plugin.preparing).toBeFalsy();
            expect(plugin.pending).toHaveLength(0);
            expect(plugin.executing).toBeFalsy();
            expect(await workflow.countExecutions()).toBe(1);
          });
          const [execution] = await workflow.getExecutions();
          expect([execution.tenantId, Date.parse(execution.context.date)]).toEqual(['B', nextDue]);
        }
        const generated = await results.findAll({ where: { label: 'Current workflow end task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
        await workflow.reload({ useMaster: true, transaction: null });
        expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
      } finally {
        trigger.off(workflow);
        await results.destroy({ where: { label: 'Current workflow end task' }, hooks: false });
      }
    },
  );

  it.each([
    { change: 'source', initiallyMain: false },
    { change: 'unchanged', initiallyMain: false },
    { change: 'main alias', initiallyMain: true },
  ])('rechecks the persisted date source after discovery ($change)', async ({ change, initiallyMain }) => {
    const name = `currentSource_${change.replace(' ', '_')}`;
    for (const db of [app.db, external]) {
      const collection = db.collection({
        name,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
          { name: 'label', type: 'string' },
        ],
      });
      await collection.model.sync();
    }
    const originalModel = (initiallyMain ? app.db : external).getModel(name);
    const otherModel = (initiallyMain ? external : app.db).getModel(name);
    const trigger = installedDateTrigger();
    const results = app.db.getModel('externalScheduleDocuments');
    const workflows = app.db.getModel('workflows');
    const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
    const nextDue = due + 3000;
    const config = { ...workflow.config, collection: initiallyMain ? name : `another:${name}` };
    const currentCollection = change === 'source' ? name : change === 'main alias' ? `main:${name}` : config.collection;
    await workflow.createNode({
      type: 'create',
      config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Current date source task' } } },
    });
    try {
      await workflows.update({ config }, { where: { id: workflow.id }, hooks: false });
      await originalModel.create(
        { id: 1, tenantId: 'B', scheduledAt: new Date(due), label: 'Original B' },
        { hooks: false },
      );
      await otherModel.create(
        { id: 1, tenantId: 'C', scheduledAt: new Date(nextDue), label: 'Other source C' },
        { hooks: false },
      );
      await observeThroughDeadline(trigger, due, async () => {
        await trigger.reload();
        await workflows.update(
          { config: { ...config, collection: currentCollection, appends: [] } },
          { where: { id: workflow.id }, hooks: false },
        );
        expect(Date.now()).toBeLessThan(due - 1000);
      });
      const plugin = app.pm.get('workflow');
      await waitForAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
        change === 'source' ? [] : [['B', due]],
      );
      await workflow.reload({ useMaster: true, transaction: null });
      expect(workflow.config.collection).toBe(currentCollection);
      if (change === 'source') {
        expect(await results.count({ where: { label: 'Current date source task' } })).toBe(0);
        expect([workflow.executed, workflow.allExecuted]).toEqual([0, 0]);
        expect(Date.now()).toBeLessThan(nextDue);
        await observeThroughDeadline(trigger, nextDue, () => trigger.reload());
        await waitForAssertion(async () => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
          expect(await workflow.countExecutions()).toBe(1);
        });
      }
      const [execution] = await workflow.getExecutions();
      expect([
        execution.tenantId,
        execution.context.data.id,
        Date.parse(execution.context.date),
        execution.context.data.label,
      ]).toEqual(change === 'source' ? ['C', 1, nextDue, 'Other source C'] : ['B', 1, due, 'Original B']);
      expect(execution.tenantContext.currentTenantId).toBe(change === 'source' ? 'C' : 'B');
      const generated = await results.findAll({ where: { label: 'Current date source task' } });
      expect(generated.map((row) => row.get('tenantId'))).toEqual([change === 'source' ? 'C' : 'B']);
      await workflow.reload({ useMaster: true, transaction: null });
      expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
    } finally {
      trigger.off(workflow);
      await results.destroy({ where: { label: 'Current date source task' }, hooks: false });
    }
  });

  it.each([true, false])(
    'rechecks the persisted start field after discovery (new field starts later: %s)',
    async (startsLater) => {
      const collection = external.collection({
        name: `externalWorkflowStart_${startsLater}`,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
          { name: 'deferredAt', type: 'date' },
        ],
      });
      await collection.model.sync();
      const trigger = installedDateTrigger();
      const results = app.db.getModel('externalScheduleDocuments');
      const workflows = app.db.getModel('workflows');
      const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
      const currentStart = due + (startsLater ? 4000 : 0);
      const config = { ...workflow.config, collection: `another:${collection.name}` };
      await workflow.createNode({
        type: 'create',
        config: {
          collection: 'externalScheduleDocuments',
          params: { values: { label: 'Current workflow start task' } },
        },
      });
      try {
        await workflows.update({ config }, { where: { id: workflow.id }, hooks: false });
        await collection.model.create(
          { tenantId: 'B', scheduledAt: new Date(due), deferredAt: new Date(currentStart) },
          { hooks: false },
        );
        await observeThroughDeadline(trigger, due, async () => {
          await trigger.reload();
          await workflows.update(
            { config: { ...config, startsOn: { field: 'deferredAt' } } },
            { where: { id: workflow.id }, hooks: false },
          );
          expect(Date.now()).toBeLessThan(due - 1000);
        });
        const plugin = app.pm.get('workflow');
        await waitForAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
          startsLater ? [] : [['B', due]],
        );
        await workflow.reload({ useMaster: true, transaction: null });
        expect(workflow.config.startsOn.field).toBe('deferredAt');
        if (startsLater) {
          expect(await results.count({ where: { label: 'Current workflow start task' } })).toBe(0);
          expect([workflow.executed, workflow.allExecuted]).toEqual([0, 0]);
          expect(Date.now()).toBeLessThan(currentStart);
          await observeThroughDeadline(trigger, currentStart, () => trigger.reload());
          await waitForAssertion(async () => {
            expect(plugin.events).toHaveLength(0);
            expect(plugin.preparing).toBeFalsy();
            expect(plugin.pending).toHaveLength(0);
            expect(plugin.executing).toBeFalsy();
            expect(await workflow.countExecutions()).toBe(1);
          });
        }
        const [execution] = await workflow.getExecutions();
        expect([execution.tenantId, Date.parse(execution.context.date)]).toEqual(['B', currentStart]);
        expect(Date.parse(execution.context.data.scheduledAt)).toBe(due);
        expect(Date.parse(execution.context.data.deferredAt)).toBe(currentStart);
        expect(execution.tenantContext.currentTenantId).toBe('B');
        const generated = await results.findAll({ where: { label: 'Current workflow start task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
        await workflow.reload({ useMaster: true, transaction: null });
        expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
      } finally {
        trigger.off(workflow);
        await results.destroy({ where: { label: 'Current workflow start task' }, hooks: false });
      }
    },
  );

  it.each([true, false])(
    'rechecks a changed nonempty start date (moves beyond the old occurrence: %s)',
    async (movesPastDue) => {
      const collection = external.collection({
        name: `externalChangedStart_${movesPastDue}`,
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'scheduledAt', type: 'date' },
        ],
      });
      await external.sync();
      const trigger = installedDateTrigger();
      const results = app.db.getCollection('externalScheduleDocuments').model;
      const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
      const currentStart = due + (movesPastDue ? 4000 : 0);
      await workflow.createNode({
        type: 'create',
        config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Changed start task' } } },
      });
      try {
        await app.db
          .getModel('workflows')
          .update(
            { config: { ...workflow.config, collection: `another:${collection.name}`, repeat: 86_400_000 } },
            { where: { id: workflow.id }, hooks: false },
          );
        const record = await collection.model.create(
          { tenantId: 'B', scheduledAt: new Date(due - 86_400_000) },
          { hooks: false },
        );
        await observeThroughDeadline(trigger, due, async () => {
          await trigger.reload();
          await collection.model.update(
            { scheduledAt: new Date(currentStart) },
            { where: { id: record.id }, hooks: false },
          );
          expect(record.get('scheduledAt').getTime()).toBe(due - 86_400_000);
          expect(Date.now()).toBeLessThan(due);
        });
        const plugin = app.pm.get('workflow');
        await waitForAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual(
          movesPastDue ? [] : [['B', due]],
        );
        expect((await record.reload()).get('scheduledAt').getTime()).toBe(currentStart);
        if (movesPastDue) {
          expect(await results.count({ where: { label: 'Changed start task' } })).toBe(0);
          await workflow.reload();
          expect([workflow.executed, workflow.allExecuted]).toEqual([0, 0]);
          expect(Date.now()).toBeLessThan(currentStart);
          await observeThroughDeadline(trigger, currentStart, () => trigger.reload());
          await waitForAssertion(async () => {
            expect(plugin.events).toHaveLength(0);
            expect(plugin.preparing).toBeFalsy();
            expect(plugin.pending).toHaveLength(0);
            expect(plugin.executing).toBeFalsy();
            expect(await workflow.countExecutions()).toBe(1);
          });
        }
        const [execution] = await workflow.getExecutions();
        expect([execution.tenantId, Date.parse(execution.context.date)]).toEqual(['B', currentStart]);
        expect(Date.parse(execution.context.data.scheduledAt)).toBe(currentStart);
        const generated = await results.findAll({ where: { label: 'Changed start task' } });
        expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
        await workflow.reload();
        expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
      } finally {
        trigger.off(workflow);
        await results.destroy({ where: { label: 'Changed start task' }, hooks: false });
      }
    },
  );

  it('rejects a cached date timer after persisted workflow disable without a local save event', async () => {
    const trigger = installedDateTrigger();
    const model = external.getCollection('externalScheduleDocuments').model;
    const results = app.db.getCollection('externalScheduleDocuments').model;
    await workflow.createNode({
      type: 'create',
      config: { collection: 'externalScheduleDocuments', params: { values: { label: 'Deadline generated' } } },
    });
    try {
      const due = Date.now() + 700;
      await model.update({ scheduledAt: new Date(due) }, { where: { id: 1 }, hooks: false });
      const record = await model.findByPk(1);
      const fired = fireTimer(trigger, record, due);
      try {
        await app.db
          .getCollection('workflows')
          .model.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
        expect(workflow.enabled).toBe(true);
        expect((await app.db.getCollection('workflows').model.findByPk(workflow.id)).enabled).toBe(false);
        expect(Date.now()).toBeLessThan(due);
      } finally {
        await fired;
      }
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await results.count({ where: { label: 'Deadline generated' } })).toBe(0);

      const current = await app.db.getRepository('workflows').findOne({ filterByTk: workflow.id });
      const initialScan = vi.spyOn(trigger, 'inspect').mockResolvedValue(undefined);
      try {
        await current.update({ enabled: true });
      } finally {
        initialScan.mockRestore();
      }
      const nextDue = Date.now() + 200;
      await model.update({ scheduledAt: new Date(nextDue) }, { where: { id: 1 }, hooks: false });
      await fireTimer(trigger, await model.findByPk(1), nextDue);
      await waitForWorkflowIdle(app);
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
      expect(executions[0].context.data.label).toBe('External B');
      const generated = await results.findAll({ where: { label: 'Deadline generated' } });
      expect(generated.map((row) => row.get('tenantId'))).toEqual(['B']);
    } finally {
      trigger.off(workflow);
      await model.update({ scheduledAt }, { where: { id: 1 }, hooks: false });
      await results.destroy({ where: { label: 'Deadline generated' }, hooks: false });
    }
  });

  it('resumes periodic discovery after a real application stop and restart', async () => {
    const trigger = installedDateTrigger();
    const cacheCycle = trigger.cacheCycle;
    const collection = external.getCollection('externalScheduleDocuments');
    try {
      await app.stop();
      trigger.cacheCycle = 1000;
      await app.start();
      // No save event: only the restarted periodic scanner can discover this change.
      const due = Math.ceil((Date.now() + 2500) / 1000) * 1000;
      await collection.model.update({ scheduledAt: new Date(due) }, { where: { id: 1 }, hooks: false });
      await waitForAssertion(async () => {
        expect(await workflow.countExecutions()).toBe(1);
      }, 5500);
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution.tenantId).toBe('B');
      expect(execution.context.data.label).toBe('External B');
    } finally {
      await app.stop();
      trigger.cacheCycle = cacheCycle;
      await collection.model.update({ scheduledAt }, { where: { id: 1 }, hooks: false });
      await app.start();
    }
  });

  async function observeThroughDeadline(trigger: DateFieldScheduleTrigger, due: number, action: () => Promise<void>) {
    const original = trigger.trigger.bind(trigger);
    const pending: Promise<unknown>[] = [];
    const dispatch = vi.spyOn(trigger, 'trigger').mockImplementation((...args) => {
      const result = original(...args);
      pending.push(result);
      return result;
    });
    try {
      await action();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 50));
      await Promise.allSettled(pending);
      await waitForWorkflowIdle(app);
    } finally {
      trigger.off(workflow);
      await Promise.allSettled(pending);
      dispatch.mockRestore();
    }
  }

  it.each([
    { scope: 'the same workflow', owner: 'C' },
    { scope: 'another workflow', owner: 'B' },
  ])(
    'keeps the correct owner when a newer scan covers $scope and the earlier scan finishes last',
    async ({ owner }) => {
      const trigger = installedDateTrigger();
      const model = external.getCollection('externalScheduleDocuments').model;
      const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
      await model.update({ scheduledAt: new Date(due) }, { where: {}, hooks: false });
      let release!: () => void;
      let reached!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const loaded = new Promise<void>((resolve) => (reached = resolve));
      const original = model.findAll.bind(model);
      let held = false;
      const query = vi.spyOn(model, 'findAll').mockImplementation(async (...args) => {
        const records = await original(...args);
        if (!held) {
          held = true;
          reached();
          await hold;
        }
        return records;
      });
      let earlier: Promise<void> | undefined;
      try {
        await observeThroughDeadline(trigger, due, async () => {
          earlier = trigger.reload();
          await loaded;
          if (owner === 'C') {
            // Controlled fixture transition, not a tenant reassignment API.
            await model.update({ tenantId: 'C' }, { where: { id: 1 }, hooks: false });
            await trigger.reload();
          } else {
            const other = await app.db.getRepository('workflows').create({
              values: {
                type: 'schedule',
                enabled: false,
                config: { ...workflow.config, collection: 'another:externalSharedSchedules' },
              },
            });
            await trigger.inspect([other]);
          }
          release();
          await earlier;
        });
        expect(await workflow.countExecutions()).toBe(1);
        const [execution] = await workflow.getExecutions();
        expect(execution.tenantId).toBe(owner);
        expect(execution.context.data.tenantId).toBe(owner);
      } finally {
        release();
        await earlier;
        query.mockRestore();
        await model.update({ tenantId: 'B', scheduledAt }, { where: { id: 1 }, hooks: false });
        await model.update({ scheduledAt }, { where: { id: 2 }, hooks: false });
      }
    },
  );

  it.each([false, true])('rejects the old business query after disable, even when re-enabled: %s', async (reEnable) => {
    const trigger = installedDateTrigger();
    const collection = external.getCollection('externalScheduleDocuments');
    const record = await collection.model.findByPk(1);
    const repository = collection.repository;
    const original = repository.findOne.bind(repository);
    let disabled = false;
    const query = vi.spyOn(repository, 'findOne').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!disabled) {
        disabled = true;
        await workflow.update({ enabled: false });
        if (reEnable) await workflow.update({ enabled: true });
      }
      return result;
    });
    try {
      await trigger.trigger(workflow, record, Date.now());
      await waitForWorkflowIdle(app);
      expect(disabled).toBe(true);
      expect(workflow.enabled).toBe(reEnable);
      expect(await workflow.countExecutions()).toBe(0);
      query.mockRestore();
      if (!reEnable) await workflow.update({ enabled: true });
      await trigger.trigger(workflow, record, Date.now());
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(await workflow.countExecutions()).toBe(1);
      expect(execution.tenantId).toBe('B');
      expect(execution.context.data.label).toBe('External B');
    } finally {
      query.mockRestore();
      trigger.off(workflow);
    }
  });

  it.each(['source scan', 'workflow discovery'])(
    'does not recreate a timer after disabling during the real %s',
    async (phase) => {
      const trigger = installedDateTrigger();
      const collection = external.getCollection('externalScheduleDocuments');
      const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
      await collection.model.update({ scheduledAt: new Date(due) }, { where: {}, hooks: false });
      let disabled = false;
      const disable = async () => {
        if (!disabled) {
          disabled = true;
          await workflow.update({ enabled: false });
        }
      };
      const originalScan = collection.model.findAll.bind(collection.model);
      const repository = app.db.getRepository('workflows');
      const originalDiscovery = repository.find.bind(repository);
      const query =
        phase === 'source scan'
          ? vi.spyOn(collection.model, 'findAll').mockImplementation(async (...args) => {
              const rows = await originalScan(...args);
              await disable();
              return rows;
            })
          : vi.spyOn(repository, 'find').mockImplementation(async (...args) => {
              const rows = await originalDiscovery(...args);
              await disable();
              return rows;
            });
      try {
        await observeThroughDeadline(trigger, due, () => trigger.reload());
        expect(disabled).toBe(true);
        expect(workflow.enabled).toBe(false);
        expect(await workflow.countExecutions()).toBe(0);
      } finally {
        query.mockRestore();
        await collection.model.update({ scheduledAt }, { where: {}, hooks: false });
      }
    },
  );

  it('does not recreate a timer from a save listener waiting for real tenant facts when disabled', async () => {
    const trigger = installedDateTrigger();
    const collection = external.getCollection('externalScheduleDocuments');
    const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
    await collection.model.update({ scheduledAt: new Date(due) }, { where: { id: 1 }, hooks: false });
    const record = await collection.model.findByPk(1);
    const repository = app.db.getRepository('tenants');
    const original = repository.findOne.bind(repository);
    let disabled = false;
    const query = vi.spyOn(repository, 'findOne').mockImplementation(async (...args) => {
      const tenant = await original(...args);
      if (!disabled) {
        disabled = true;
        await workflow.update({ enabled: false });
      }
      return tenant;
    });
    try {
      await observeThroughDeadline(trigger, due, () =>
        external.emitAsync('externalScheduleDocuments.afterSaveWithAssociations', record, {}),
      );
      expect(disabled).toBe(true);
      expect(await workflow.countExecutions()).toBe(0);
    } finally {
      query.mockRestore();
      await collection.model.update({ scheduledAt }, { where: { id: 1 }, hooks: false });
    }
  });

  async function fireTimer(trigger: DateFieldScheduleTrigger, record, due: number) {
    const original = trigger.trigger.bind(trigger);
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispatch = vi.spyOn(trigger, 'trigger').mockImplementation((...args) => {
      const result = original(...args);
      // Observe the real query's settlement so a RED cannot leak into teardown.
      void result.then(finish, finish);
      return result;
    });
    try {
      trigger.schedule(workflow, record, due);
      await settled;
    } finally {
      dispatch.mockRestore();
    }
  }

  async function selectTimerCollection(name: string) {
    const collection = external.collection({
      name,
      tenancy: 'shared',
      fields: [
        { name: 'label', type: 'string' },
        { name: 'scheduledAt', type: 'date' },
      ],
    });
    const installed = (app.pm.get('workflow') as WorkflowPlugin).triggers.get('schedule') as unknown as {
      modes: Map<number, DateFieldScheduleTrigger>;
    };
    const initialScan = vi.spyOn(installed.modes.get(1)!, 'inspect').mockResolvedValue(undefined);
    try {
      await workflow.update({ config: { ...workflow.config, collection: `another:${name}` } });
    } finally {
      initialScan.mockRestore();
    }
    return collection;
  }

  it('logs a due timer SQL failure and permits an explicit fresh schedule after the source recovers', async () => {
    const collection = await selectTimerCollection('timerUnavailableScheduleDocuments');
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const trigger = new DateFieldScheduleTrigger(plugin);
    const errors = vi.spyOn(plugin.getLogger(workflow.id), 'error');
    const values = { id: 10, label: 'Recovered timer', scheduledAt: new Date() };
    const record = collection.model.build(values);
    try {
      await expect(trigger.schedule(workflow, record, Date.now() - 1)).rejects.toThrow(/no such table/i);
      const due = Date.now() + 200;
      await fireTimer(trigger, record, due);
      expect(await workflow.countExecutions()).toBe(0);
      expect(errors).toHaveBeenCalledWith(
        'failed to trigger scheduled record',
        expect.objectContaining({ name: 'SequelizeDatabaseError' }),
      );
      await collection.model.sync();
      await collection.model.create(values, { hooks: false });
      await trigger.schedule(workflow, record, due);
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution.context.data.label).toBe('Recovered timer');
      expect(await workflow.countExecutions()).toBe(1);
    } finally {
      trigger.off(workflow);
      errors.mockRestore();
    }
  });

  it('releases a consumed timer when its cached record no longer exists', async () => {
    const collection = await selectTimerCollection('timerMissingScheduleDocuments');
    await collection.model.sync();
    const values = { id: 11, label: 'Recreated record', scheduledAt: new Date() };
    const stale = await collection.model.create(values, { hooks: false });
    await collection.model.destroy({ where: { id: 11 }, hooks: false });
    const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
    const due = Date.now() + 200;
    try {
      await fireTimer(trigger, stale, due);
      expect(await workflow.countExecutions()).toBe(0);
      await collection.model.create(values, { hooks: false });
      await trigger.schedule(workflow, stale, due);
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution?.context.data.label).toBe('Recreated record');
      expect(await workflow.countExecutions()).toBe(1);
    } finally {
      trigger.off(workflow);
    }
  });

  it('logs a real workflow discovery failure and can complete the next reload after recovery', async () => {
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const trigger = new DateFieldScheduleTrigger(plugin);
    const errors = vi.spyOn(plugin.getLogger('dispatcher'), 'error');
    const qi = app.db.sequelize.getQueryInterface();
    const table = app.db.getCollection('workflows').model.getTableName();
    const unavailable = 'unavailable_workflows_for_schedule_reload';
    const model = external.getCollection('externalScheduleDocuments').model;
    try {
      await qi.renameTable(table, unavailable);
      try {
        await expect(trigger.reload()).resolves.toBeUndefined();
        expect(errors).toHaveBeenCalledWith(
          'failed to reload date-field schedules',
          expect.objectContaining({ name: 'SequelizeDatabaseError' }),
        );
      } finally {
        await qi.renameTable(unavailable, table);
      }
      await model.update({ scheduledAt: new Date(Date.now() + 1000) }, { where: {}, hooks: false });
      await expect(trigger.reload()).resolves.toBeUndefined();
      await waitForAssertion(async () => expect(await workflow.countExecutions()).toBe(1));
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution.context.data.label).toBe('External B');
      expect(execution.tenantId).toBe('B');
    } finally {
      trigger.off(workflow);
      errors.mockRestore();
      await model.update({ scheduledAt }, { where: {}, hooks: false });
    }
  });

  it('keeps pending timers cancellable across a successful reload', async () => {
    const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
    const model = external.getCollection('externalScheduleDocuments').model;
    const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
    const original = trigger.trigger.bind(trigger);
    const pending: Promise<unknown>[] = [];
    const dispatch = vi.spyOn(trigger, 'trigger').mockImplementation((...args) => {
      const result = original(...args);
      pending.push(result);
      return result;
    });
    try {
      await model.update({ scheduledAt: new Date(due) }, { where: {}, hooks: false });
      const record = await model.findByPk(1);
      trigger.schedule(workflow, record, due);
      await trigger.reload();
      trigger.off(workflow);
      // A real deadline barrier lets any orphaned native timer fire before checking persisted executions.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 50));
      await Promise.allSettled(pending);
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
    } finally {
      trigger.off(workflow);
      await Promise.allSettled(pending);
      dispatch.mockRestore();
      await model.update({ scheduledAt }, { where: {}, hooks: false });
    }
  });

  it('retains an already scheduled timer when a reload temporarily cannot scan its source', async () => {
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const trigger = new DateFieldScheduleTrigger(plugin);
    const model = external.getCollection('externalScheduleDocuments').model;
    const qi = external.sequelize.getQueryInterface();
    const table = model.getTableName();
    const unavailable = 'unavailable_source_during_schedule_reload';
    const errors = vi.spyOn(plugin.getLogger(workflow.id), 'error');
    const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
    try {
      await model.update({ scheduledAt: new Date(due) }, { where: {}, hooks: false });
      const record = await model.findByPk(1);
      trigger.schedule(workflow, record, due);
      await qi.renameTable(table, unavailable);
      try {
        await trigger.reload();
        expect(errors).toHaveBeenCalledWith(
          'failed to inspect scheduled records',
          expect.objectContaining({ name: 'SequelizeDatabaseError' }),
        );
      } finally {
        await qi.renameTable(unavailable, table);
      }
      await waitForAssertion(async () => expect(await workflow.countExecutions()).toBe(1), 4000);
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution.context.data.label).toBe('External B');
      expect(execution.tenantId).toBe('B');
    } finally {
      trigger.off(workflow);
      errors.mockRestore();
      await model.update({ scheduledAt }, { where: {}, hooks: false });
    }
  });

  it('refreshes a pending record owner from the successful reload instead of suppressing the new context', async () => {
    const trigger = new DateFieldScheduleTrigger(app.pm.get('workflow') as WorkflowPlugin);
    const model = external.getCollection('externalScheduleDocuments').model;
    const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
    try {
      await model.update({ scheduledAt: new Date(due) }, { where: {}, hooks: false });
      const record = await model.findByPk(1);
      trigger.schedule(workflow, record, due);
      await model.update({ tenantId: 'C' }, { where: { id: 1 }, hooks: false });
      await trigger.reload();
      await waitForAssertion(async () => expect(await workflow.countExecutions()).toBe(1), 4000);
      await waitForWorkflowIdle(app);
      const [execution] = await workflow.getExecutions();
      expect(execution.tenantId).toBe('C');
      expect(execution.context.data.tenantId).toBe('C');
    } finally {
      trigger.off(workflow);
      await model.update({ tenantId: 'B' }, { where: { id: 1 }, hooks: false });
      await model.update({ scheduledAt }, { where: {}, hooks: false });
    }
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
    const initialScan = vi.spyOn(installed.modes.get(1)!, 'inspect').mockResolvedValue(undefined);
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

  it('waits for inspection and logs a real scan failure while still scheduling another workflow', async () => {
    external.collection({
      name: 'unavailableScheduleDocuments',
      fields: [{ name: 'scheduledAt', type: 'date' }],
    });
    const failed = await app.db.getRepository('workflows').create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { ...workflow.config, collection: 'another:unavailableScheduleDocuments' },
      },
    });
    const future = new Date(Date.now() + 60_000);
    const model = external.getCollection('externalScheduleDocuments').model;
    await model.update({ scheduledAt: future }, { where: {}, hooks: false });
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const trigger = new DateFieldScheduleTrigger(plugin);
    const errors = vi.spyOn(plugin.getLogger(failed.id), 'error');
    const schedule = vi.spyOn(trigger, 'schedule').mockImplementation(() => undefined);
    const load = trigger.loadRecordsToSchedule.bind(trigger);
    const pending: Promise<unknown>[] = [];
    vi.spyOn(trigger, 'loadRecordsToSchedule').mockImplementation((...args) => {
      const result = load(...args);
      pending.push(result);
      return result;
    });
    try {
      await expect(trigger.inspect([failed, workflow])).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalledWith(
        'failed to inspect scheduled records',
        expect.objectContaining({
          name: 'SequelizeDatabaseError',
        }),
      );
      const additions = schedule.mock.calls.filter((call) => call[3] === true);
      expect(additions).toHaveLength(1);
      expect(additions[0][0]).toBe(workflow);
      expect(additions[0][1].get('label')).toBe('External B');
      expect(additions[0][2]).toBe(future.getTime() - future.getMilliseconds());
    } finally {
      await Promise.allSettled(pending);
      errors.mockRestore();
      await model.update({ scheduledAt }, { where: {}, hooks: false });
    }
  });
});
