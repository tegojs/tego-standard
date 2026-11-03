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

  async function createFixture() {
    app = await createMockServer({
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
});
