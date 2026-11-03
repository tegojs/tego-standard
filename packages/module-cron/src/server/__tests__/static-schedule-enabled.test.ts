import { PluginWorkflow } from '@tachybase/module-workflow';
import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion } from '../../../../module-workflow/src/server/__tests__/utils';
import cronJobs from '../../collections/cronJobs';
import { CronJobModel } from '../model/CronJobModel';
import { CronJobLock } from '../service/CronJobLock';
import { StaticScheduleTrigger } from '../service/StaticScheduleTrigger';

describe('cron state at dispatch', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  async function createFixture(skipStart = false) {
    app = await createMockServer({
      skipStart,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'error-handler',
        'collection',
        'user',
        [PluginWorkflow, { name: 'workflow', packageName: '@tachybase/module-workflow' }],
      ],
    });
    app.db.registerModels({ CronJobModel });
    app.db.collection(cronJobs);
    app.db.collection({ name: 'cronContextSource', tenancy: 'shared', fields: [] });
    app.db.collection({
      name: 'cronEnabledResults',
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
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', enabled: true, config: { collection: 'cronContextSource', mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'cronEnabledResults', params: { values: { label: 'Enabled cron task' } } },
    });
    expect(app.pm.get(PluginWorkflow)).toBe(app.pm.get('workflow'));
    const repository = app.db.getRepository('cronJobs');
    const cronJob = await repository.create({
      values: {
        name: 'Enabled state fixture',
        workflowKey: workflow.key,
        startsOn: new Date(),
        mode: 0,
        repeat: '',
        enabled: true,
      },
    });
    const lock = new CronJobLock();
    Object.assign(lock, { app, logger: app.logger });
    await lock.load();
    const service = new StaticScheduleTrigger();
    Object.assign(service, { app, db: app.db, logger: app.logger, cronJobLock: lock });
    return { workflow, repository, cronJob, lock, service };
  }

  it('skips a job disabled while its real cache lock is being acquired and allows a later enabled call', async () => {
    const { workflow, repository, cronJob, lock, service } = await createFixture();
    const time = Math.floor(Date.now() / 1000) * 1000;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let acquired = false;
    const acquire = lock.acquire.bind(lock);
    const acquiring = vi.spyOn(lock, 'acquire').mockImplementation(async (...args) => {
      const result = await acquire(...args);
      expect(result).toBe(true);
      acquired = true;
      await hold;
      return result;
    });
    const triggering = service.trigger(cronJob.id, time);
    try {
      await waitForFastAssertion(() => expect(acquired).toBe(true));
      expect(await lock.isLocked(cronJob.id, time)).toBe(true);
      await repository.update({ filterByTk: cronJob.id, values: { enabled: false } });
      release();
      await triggering;
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.enabled, persisted.allExecuted, persisted.limitExecuted]).toEqual([false, 0, 0]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    } finally {
      release();
      try {
        await triggering;
      } finally {
        acquiring.mockRestore();
      }
    }
    await repository.update({ filterByTk: cronJob.id, values: { enabled: true } });
    await service.trigger(cronJob.id, time);
    await waitForFastAssertion(async () => {
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
      const rows = await app.db.getRepository('cronEnabledResults').find();
      expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
    });
    expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    const persisted = await repository.findOne({ filterByTk: cronJob.id });
    expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
  });

  it.each(['cronJobs', 'workflows'])(
    'releases its cache lock after a real %s lookup SQL failure',
    async (collection) => {
      const { workflow, repository, cronJob, lock, service } = await createFixture();
      const time = Math.floor(Date.now() / 1000) * 1000;
      const model = app.db.getModel(collection);
      const errors: string[] = [];
      const error = app.logger.error.bind(app.logger);
      const logging = vi.spyOn(app.logger, 'error').mockImplementation((...args) => {
        errors.push(String(args[0]));
        return error(...args);
      });
      model.addHook('beforeFind', 'fail-cron-dispatch-read', (options) => {
        options.where = { missingCronDispatchColumn: true };
      });
      try {
        await service.trigger(cronJob.id, time);
      } finally {
        model.removeHook('beforeFind', 'fail-cron-dispatch-read');
        logging.mockRestore();
      }
      expect(errors.some((message) => /no such column.*missingCronDispatchColumn/.test(message))).toBe(true);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([0, 0]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);

      await service.trigger(cronJob.id, time);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
      });
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    },
  );

  it('leaves a competing cache lock intact when acquisition is refused', async () => {
    const { workflow, cronJob, lock, service } = await createFixture();
    const time = Math.floor(Date.now() / 1000) * 1000;
    expect(await lock.acquire(cronJob.id, time)).toBe(true);
    await service.trigger(cronJob.id, time);
    expect(await lock.isLocked(cronJob.id, time)).toBe(true);
    expect(await workflow.countExecutions()).toBe(0);
    expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
    await lock.release(cronJob.id, time);
  });

  it('reschedules a persisted tenant cron job after stopping and restarting before its due time', async () => {
    const { workflow, repository, cronJob, service } = await createFixture();
    await service.load();
    const time = Math.floor(Date.now() / 1000) * 1000 + 10000;
    try {
      await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(time) } });
      expect(await workflow.countExecutions()).toBe(0);
      await app.stop();
      expect(await app.isStarted()).toBe(false);
      await app.start();
      expect(await app.isStarted()).toBe(true);
      expect(Date.now()).toBeLessThan(time);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
        expect(new Date(executions[0].context.date).getTime()).toBe(time);
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
      }, 15000);
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
    } finally {
      service.off(cronJob);
    }
  });

  it('discards a due tenant batch whose SQL result is delivered after stop and restart', async () => {
    const { workflow, repository, cronJob, lock, service } = await createFixture();
    await service.load();
    const time = Math.floor(Date.now() / 1000) * 1000 + 2000;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let read = false;
    let triggering: Promise<void> | undefined;
    const trigger = service.trigger.bind(service);
    const firing = vi.spyOn(service, 'trigger').mockImplementation((...args) => {
      triggering = trigger(...args);
      return triggering;
    });
    const tenants = app.db.getModel('tenants');
    tenants.addHook('afterFind', 'hold-cron-tenant-delivery', async () => {
      if (read) return;
      read = true;
      await hold;
    });
    try {
      await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(time) } });
      expect(Date.now()).toBeLessThan(time);
      await waitForFastAssertion(() => expect(read).toBe(true));
      expect(await lock.isLocked(cronJob.id, time)).toBe(true);
      await app.stop();
      expect(await app.isStarted()).toBe(false);
      await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(time + 1100));
      await app.start();
      expect(await app.isStarted()).toBe(true);
      release();
      await triggering;
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([0, 0]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    } finally {
      release();
      try {
        await triggering;
      } finally {
        tenants.removeHook('afterFind', 'hold-cron-tenant-delivery');
        firing.mockRestore();
        service.off(cronJob);
      }
    }
    await service.trigger(cronJob.id, time);
    await waitForFastAssertion(async () => {
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
      const rows = await app.db.getRepository('cronEnabledResults').find();
      expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
    });
    const persisted = await repository.findOne({ filterByTk: cronJob.id });
    expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
  });

  it('discards an initial cron list delivered after stop and a newer startup', async () => {
    const { workflow, repository, cronJob, service } = await createFixture(true);
    const oldTime = Math.floor(Date.now() / 1000) * 1000 + 6000;
    const newTime = oldTime + 3000;
    await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(oldTime) } });
    await service.load();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let discovered = false;
    const jobs = app.db.getModel('cronJobs');
    jobs.addHook('afterFind', 'hold-cron-startup-delivery', async (rows) => {
      if (discovered || !Array.isArray(rows)) return;
      expect(rows.map((row) => new Date(row.get('startsOn')).getTime())).toEqual([oldTime]);
      discovered = true;
      await hold;
    });
    const starting = app.start();
    try {
      await waitForFastAssertion(() => expect(discovered).toBe(true));
      await app.stop();
      expect(await app.isStarted()).toBe(false);
      await jobs.update({ startsOn: new Date(newTime) }, { where: { id: cronJob.id }, hooks: false });
      await app.start();
      expect(await app.isStarted()).toBe(true);
      expect(Date.now()).toBeLessThan(oldTime);
      release();
      await starting;
      await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(oldTime + 500));
      expect(Date.now()).toBeLessThan(newTime);
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])).toEqual(
          [['B', newTime]],
        );
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
      });
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect(new Date(persisted.startsOn).getTime()).toBe(newTime);
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
    } finally {
      release();
      try {
        await starting;
      } finally {
        jobs.removeHook('afterFind', 'hold-cron-startup-delivery');
        service.off(cronJob);
      }
    }
  });

  it('stops an accepted tenant batch before dispatching later tenants after restart', async () => {
    const { workflow, repository, cronJob, lock, service } = await createFixture();
    await app.db.getRepository('tenants').create({ values: { id: 'C', enabled: true } });
    const time = Math.floor(Date.now() / 1000) * 1000 - 10000;
    await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(time) } });
    await service.load();
    const plugin = app.pm.get('workflow');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let accepted = false;
    const trigger = plugin.trigger.bind(plugin);
    const triggering = vi.spyOn(plugin, 'trigger').mockImplementation(async (...args) => {
      const result = await trigger(...args);
      if (!accepted) {
        expect(args[2].context.state.currentTenantId).toBe('B');
        await waitForFastAssertion(async () => {
          const rows = await app.db.getRepository('cronEnabledResults').find();
          expect(rows.map((row) => row.tenantId)).toEqual(['B']);
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        accepted = true;
        await hold;
      }
      return result;
    });
    const pending = service.trigger(cronJob.id, time);
    try {
      await waitForFastAssertion(() => expect(accepted).toBe(true));
      await app.stop();
      expect(await app.isStarted()).toBe(false);
      await app.start();
      expect(await app.isStarted()).toBe(true);
      release();
      await pending;
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      const executions = await workflow.getExecutions();
      expect(executions.map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])).toEqual([
        ['B', time],
      ]);
      const rows = await app.db.getRepository('cronEnabledResults').find();
      expect(rows.map((row) => row.tenantId)).toEqual(['B']);
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    } finally {
      release();
      try {
        await pending;
      } finally {
        triggering.mockRestore();
        service.off(cronJob);
      }
    }
    const nextTime = time + 1000;
    await service.trigger(cronJob.id, nextTime);
    await waitForFastAssertion(async () => {
      const executions = await workflow.getExecutions();
      expect(
        executions
          .map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ).toEqual([
        ['B', time],
        ['B', nextTime],
        ['C', nextTime],
      ]);
      const rows = await app.db.getRepository('cronEnabledResults').find();
      expect(rows.map((row) => row.tenantId).sort()).toEqual(['B', 'B', 'C']);
    });
    const persisted = await repository.findOne({ filterByTk: cronJob.id });
    expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([2, 2]);
    expect(await lock.isLocked(cronJob.id, nextTime)).toBe(false);
  });

  it('invalidates a pending occurrence when saving a new cron time and runs the new timer', async () => {
    const { workflow, repository, cronJob, lock, service } = await createFixture();
    await service.load();
    const time = Math.floor(Date.now() / 1000) * 1000;
    const nextTime = time + 6000;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let acquired = false;
    const acquire = lock.acquire.bind(lock);
    const acquiring = vi.spyOn(lock, 'acquire').mockImplementation(async (...args) => {
      const result = await acquire(...args);
      if (!acquired) {
        expect(result).toBe(true);
        acquired = true;
        await hold;
      }
      return result;
    });
    const pending = service.trigger(cronJob.id, time);
    try {
      await waitForFastAssertion(() => expect(acquired).toBe(true));
      expect(await lock.isLocked(cronJob.id, time)).toBe(true);
      await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(nextTime) } });
      expect(Date.now()).toBeLessThan(nextTime);
      release();
      await pending;
      acquiring.mockRestore();
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      const rescheduled = await repository.findOne({ filterByTk: cronJob.id });
      expect(new Date(rescheduled.startsOn).getTime()).toBe(nextTime);
      expect([rescheduled.allExecuted, rescheduled.limitExecuted]).toEqual([0, 0]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])).toEqual(
          [['B', nextTime]],
        );
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
      });
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
      expect(await lock.isLocked(cronJob.id, nextTime)).toBe(false);
    } finally {
      release();
      try {
        await pending;
      } finally {
        acquiring.mockRestore();
        service.off(cronJob);
      }
    }
  });

  it('keeps another cron occurrence active when cancelling an unrelated job', async () => {
    const { workflow, repository, cronJob, lock, service } = await createFixture();
    const other = await repository.create({
      values: {
        name: 'Unrelated cancellation fixture',
        workflowKey: workflow.key,
        startsOn: new Date(Date.now() + 60000),
        mode: 0,
        repeat: '',
        enabled: true,
      },
    });
    await service.load();
    const time = Math.floor(Date.now() / 1000) * 1000;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let acquired = false;
    const acquire = lock.acquire.bind(lock);
    const acquiring = vi.spyOn(lock, 'acquire').mockImplementation(async (...args) => {
      const result = await acquire(...args);
      expect(result).toBe(true);
      acquired = true;
      await hold;
      return result;
    });
    const pending = service.trigger(cronJob.id, time);
    try {
      await waitForFastAssertion(() => expect(acquired).toBe(true));
      service.off(other);
      release();
      await pending;
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])).toEqual(
          [['B', time]],
        );
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
      });
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      const untouched = await repository.findOne({ filterByTk: other.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
      expect([untouched.allExecuted, untouched.limitExecuted]).toEqual([0, 0]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    } finally {
      release();
      try {
        await pending;
      } finally {
        acquiring.mockRestore();
        service.off(cronJob);
        service.off(other);
      }
    }
  });

  it('discards an initial cron row rescheduled while its SQL result is pending', async () => {
    const { workflow, repository, cronJob, service } = await createFixture(true);
    const oldTime = Math.floor(Date.now() / 1000) * 1000 + 6000;
    const otherTime = oldTime + 1000;
    const nextTime = oldTime + 3000;
    await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(oldTime) } });
    const other = await repository.create({
      values: {
        name: 'Unchanged startup row',
        workflowKey: workflow.key,
        startsOn: new Date(otherTime),
        mode: 0,
        repeat: '',
        enabled: true,
      },
    });
    await service.load();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let discovered = false;
    const jobs = app.db.getModel('cronJobs');
    jobs.addHook('afterFind', 'hold-cron-reschedule-discovery', async (rows) => {
      if (discovered || !Array.isArray(rows)) return;
      expect(rows.map((row) => new Date(row.get('startsOn')).getTime()).sort()).toEqual([oldTime, otherTime]);
      discovered = true;
      await hold;
    });
    const starting = app.start();
    try {
      await waitForFastAssertion(() => expect(discovered).toBe(true));
      await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(nextTime) } });
      expect(Date.now()).toBeLessThan(oldTime);
      release();
      await starting;
      expect(await app.isStarted()).toBe(true);
      await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(oldTime + 500));
      expect(Date.now()).toBeLessThan(otherTime);
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])).toEqual(
          [
            ['B', otherTime],
            ['B', nextTime],
          ],
        );
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([
          ['B', 'Enabled cron task'],
          ['B', 'Enabled cron task'],
        ]);
      });
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      const untouched = await repository.findOne({ filterByTk: other.id });
      expect(new Date(persisted.startsOn).getTime()).toBe(nextTime);
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
      expect([untouched.allExecuted, untouched.limitExecuted]).toEqual([1, 1]);
    } finally {
      release();
      try {
        await starting;
      } finally {
        jobs.removeHook('afterFind', 'hold-cron-reschedule-discovery');
        service.off(cronJob);
        service.off(other);
      }
    }
  });

  it('retains a replacement timer handle when an older same-key invocation finishes', async () => {
    const { workflow, repository, cronJob, lock, service } = await createFixture();
    await service.load();
    const time = Math.floor(Date.now() / 1000) * 1000 + 3000;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let acquired = false;
    const acquire = lock.acquire.bind(lock);
    const acquiring = vi.spyOn(lock, 'acquire').mockImplementation(async (...args) => {
      const result = await acquire(...args);
      if (!acquired) {
        expect(result).toBe(true);
        acquired = true;
        await hold;
      }
      return result;
    });
    const trigger = service.trigger.bind(service);
    const calls: Promise<void>[] = [];
    const observing = vi.spyOn(service, 'trigger').mockImplementation((...args) => {
      const result = trigger(...args);
      calls.push(result);
      return result;
    });
    try {
      await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(time) } });
      const scheduled = await repository.findOne({ filterByTk: cronJob.id });
      await waitForFastAssertion(() => expect(acquired).toBe(true));
      expect(await lock.isLocked(cronJob.id, time)).toBe(true);
      expect(Date.now()).toBeLessThan(time + 500);
      expect(service.getNextTime(scheduled, new Date())).toBe(time);
      service.off(scheduled);
      service.on(scheduled);
      release();
      await calls[0];
      expect(calls).toHaveLength(1);
      service.off(scheduled);
      await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(time + 1000));
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('cronEnabledResults').count()).toBe(0);
      const cancelled = await repository.findOne({ filterByTk: cronJob.id });
      expect([cancelled.allExecuted, cancelled.limitExecuted]).toEqual([0, 0]);
      expect(await lock.isLocked(cronJob.id, time)).toBe(false);
    } finally {
      release();
      try {
        await Promise.all(calls);
      } finally {
        acquiring.mockRestore();
        observing.mockRestore();
        service.off(cronJob);
      }
    }
    const nextTime = Math.floor(Date.now() / 1000) * 1000 + 2000;
    await repository.update({ filterByTk: cronJob.id, values: { startsOn: new Date(nextTime) } });
    try {
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => [execution.tenantId, new Date(execution.context.date).getTime()])).toEqual(
          [['B', nextTime]],
        );
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Enabled cron task']]);
      });
      const persisted = await repository.findOne({ filterByTk: cronJob.id });
      expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([1, 1]);
      expect(await lock.isLocked(cronJob.id, nextTime)).toBe(false);
    } finally {
      service.off(cronJob);
    }
  });

  it.each([
    { endsOn: '2026-01-01T00:00:01.000Z', expected: null },
    { endsOn: '2026-01-01T00:00:02.000Z', expected: '2026-01-01T00:00:02.000Z' },
  ])('bounds cron-expression repeats by $endsOn', async ({ endsOn, expected }) => {
    const { repository, cronJob, service } = await createFixture();
    await repository.update({
      filterByTk: cronJob.id,
      values: { startsOn: new Date('2026-01-01T00:00:00.000Z'), repeat: '*/2 * * * * *', endsOn: new Date(endsOn) },
    });
    const persisted = await repository.findOne({ filterByTk: cronJob.id });
    const nextTime = service.getNextTime(persisted, new Date('2026-01-01T00:00:00.000Z'));
    expect(nextTime == null ? null : new Date(nextTime).toISOString()).toBe(expected);
  });

  it.each([
    { endOffset: 1000, expectedDates: [0] },
    { endOffset: 2000, expectedDates: [0, 2000] },
  ])(
    'runs only the tenant cron occurrences within an end offset of $endOffset ms',
    async ({ endOffset, expectedDates }) => {
      const { workflow, repository, cronJob, service } = await createFixture();
      await service.load();
      const time = Math.floor(Date.now() / 1000) * 1000 + 2000;
      try {
        await repository.update({
          filterByTk: cronJob.id,
          values: { startsOn: new Date(time), repeat: '2000', endsOn: new Date(time + endOffset) },
        });
        expect(Date.now()).toBeLessThan(time);
        await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(time + 3500), 10000);
        const plugin = app.pm.get('workflow');
        await waitForFastAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions.map((execution) => new Date(execution.context.date).getTime() - time)).toEqual(expectedDates);
        expect(executions.map((execution) => execution.tenantId)).toEqual(expectedDates.map(() => 'B'));
        const rows = await app.db.getRepository('cronEnabledResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual(
          expectedDates.map(() => ['B', 'Enabled cron task']),
        );
        const persisted = await repository.findOne({ filterByTk: cronJob.id });
        expect([persisted.allExecuted, persisted.limitExecuted]).toEqual([expectedDates.length, expectedDates.length]);
      } finally {
        service.off(cronJob);
      }
    },
  );
});
