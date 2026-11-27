import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../utils';

describe('static schedule discovery lifecycle', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    app.db.collection({ name: 'staticLifecycleResults', fields: [{ name: 'label', type: 'string' }] });
    await app.db.sync();
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    { repeat: 2000, endOffset: -1000, expectedDates: [] },
    { repeat: 2000, endOffset: 0, expectedDates: [0] },
    { repeat: '*/2 * * * * *', endOffset: -1000, expectedDates: [] },
    { repeat: '*/2 * * * * *', endOffset: 0, expectedDates: [0] },
  ])(
    'bounds the first static occurrence of $repeat by end offset $endOffset ms',
    async ({ repeat, endOffset, expectedDates }) => {
      const workflow = await app.db.getRepository('workflows').create({
        values: { type: 'schedule', enabled: false, config: { mode: 0 } },
      });
      await workflow.createNode({
        type: 'create',
        config: { collection: 'staticLifecycleResults', params: { values: { label: 'First bounded static task' } } },
      });
      const due = Math.ceil((Date.now() + 2000) / 2000) * 2000;
      try {
        await workflow.update({
          enabled: true,
          config: {
            mode: 0,
            startsOn: new Date(due).toISOString(),
            endsOn: new Date(due + endOffset).toISOString(),
            repeat,
          },
        });
        expect(Date.now()).toBeLessThan(due - 1000);
        await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(due + 2500), 10000);
        const plugin = app.pm.get('workflow');
        await waitForFastAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions.map((execution) => Date.parse(execution.context.date) - due)).toEqual(expectedDates);
        const rows = await app.db.getRepository('staticLifecycleResults').find();
        expect(rows.map((row) => row.label)).toEqual(expectedDates.map(() => 'First bounded static task'));
        await workflow.reload({ useMaster: true, transaction: null });
        expect([workflow.executed, workflow.allExecuted]).toEqual([expectedDates.length, expectedDates.length]);
      } finally {
        await workflow.update({ enabled: false });
      }
    },
  );

  it.each([
    { repeat: 2000, endOffset: 1000, expectedDates: [0] },
    { repeat: 2000, endOffset: 2000, expectedDates: [0, 2000] },
    { repeat: '*/2 * * * * *', endOffset: 1000, expectedDates: [0] },
    { repeat: '*/2 * * * * *', endOffset: 2000, expectedDates: [0, 2000] },
  ])('bounds static repeat $repeat by an end offset of $endOffset ms', async ({ repeat, endOffset, expectedDates }) => {
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Bounded static task' } } },
    });
    const time = Math.ceil((Date.now() + 2000) / 2000) * 2000;
    try {
      await workflow.update({
        enabled: true,
        config: {
          mode: 0,
          startsOn: new Date(time).toISOString(),
          endsOn: new Date(time + endOffset).toISOString(),
          repeat,
        },
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
      const rows = await app.db.getRepository('staticLifecycleResults').find();
      expect(rows.map((row) => row.label)).toEqual(expectedDates.map(() => 'Bounded static task'));
      await workflow.reload({ useMaster: true, transaction: null });
      expect([workflow.executed, workflow.allExecuted]).toEqual([expectedDates.length, expectedDates.length]);
    } finally {
      await workflow.update({ enabled: false });
    }
  });

  it.each([
    { repeat: 1000, earlyReference: false },
    { repeat: '*/2 * * * * *', earlyReference: false },
    { repeat: 1000, earlyReference: true },
    { repeat: '*/2 * * * * *', earlyReference: true },
  ])(
    'preserves the next static repeat $repeat while its authority read is delayed (controlled early reference: $earlyReference)',
    async ({ repeat, earlyReference }) => {
      const repository = app.db.getRepository('workflows');
      const workflow = await repository.create({
        values: { type: 'schedule', enabled: false, config: { mode: 0 } },
      });
      await workflow.createNode({
        type: 'create',
        config: { collection: 'staticLifecycleResults', params: { values: { label: 'Delayed static repeat' } } },
      });
      const plugin = app.pm.get('workflow');
      const mode = plugin.triggers.get('schedule').modes.get(0);
      const trigger = mode.trigger.bind(mode);
      const calls: Promise<void>[] = [];
      let enteredAt: number;
      const observing = vi.spyOn(mode, 'trigger').mockImplementation((...args) => {
        enteredAt ??= Date.now();
        let result: Promise<void>;
        if (earlyReference && calls.length === 0) {
          vi.useFakeTimers({ toFake: ['Date'] });
          try {
            vi.setSystemTime(due - 1);
            result = trigger(...args);
          } finally {
            vi.useRealTimers();
          }
        } else {
          result = trigger(...args);
        }
        calls.push(result);
        return result;
      });
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let checked = false;
      const findOne = repository.findOne.bind(repository);
      const authority = vi.spyOn(repository, 'findOne').mockImplementation(async (options) => {
        const result = await findOne(options);
        if (!checked && options?.filter?.enabled === true && options.filter['config.mode'] === 0) {
          expect(result.id).toBe(workflow.id);
          checked = true;
          await hold;
        }
        return result;
      });
      const due = Math.ceil((Date.now() + 2000) / 2000) * 2000;
      try {
        await workflow.update({
          enabled: true,
          config: {
            mode: 0,
            startsOn: new Date(due).toISOString(),
            endsOn: new Date(due + 2000).toISOString(),
            repeat,
          },
        });
        await waitForFastAssertion(() => expect(checked).toBe(true));
        expect(enteredAt).toBeGreaterThanOrEqual(due);
        expect(enteredAt).toBeLessThan(due + 1000);
        expect(Date.now()).toBeLessThan(due + 1000);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, due + 1100 - Date.now())));
        expect(Date.now()).toBeGreaterThanOrEqual(due + 1100);
        expect(Date.now()).toBeLessThan(due + 1900);
        release();
        await calls[0];
        await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(due + 2600));
        await waitForFastAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(executions.map((execution) => Date.parse(execution.context.date))).toEqual([due, due + 2000]);
        const rows = await app.db.getRepository('staticLifecycleResults').find();
        expect(rows.map((row) => row.label)).toEqual(['Delayed static repeat', 'Delayed static repeat']);
        await workflow.reload({ useMaster: true, transaction: null });
        expect([workflow.executed, workflow.allExecuted]).toEqual([2, 2]);
      } finally {
        release();
        mode.off(workflow);
        await Promise.allSettled(calls);
        authority.mockRestore();
        observing.mockRestore();
        await workflow.update({ enabled: false });
      }
    },
  );

  it.each([
    { startOffset: 5000, expectedDates: [] },
    { startOffset: 0, expectedDates: [0] },
  ])(
    'checks the primary static configuration after another writer moves startsOn by $startOffset ms',
    async ({ startOffset, expectedDates }) => {
      const repository = app.db.getRepository('workflows');
      const workflow = await repository.create({
        values: { type: 'schedule', enabled: false, config: { mode: 0 } },
      });
      await workflow.createNode({
        type: 'create',
        config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current primary schedule' } } },
      });
      const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
      try {
        await workflow.update({ enabled: true, config: { mode: 0, startsOn: new Date(due).toISOString() } });
        const currentConfig = {
          mode: 0,
          startsOn: new Date(due + startOffset).toISOString(),
          endsOn: new Date(due + 10000).toISOString(),
        };
        await app.db
          .getModel('workflows')
          .update({ config: currentConfig }, { where: { id: workflow.id }, hooks: false });
        expect(workflow.config.startsOn).toBe(new Date(due).toISOString());
        const current = await repository.findOne({ filterByTk: workflow.id, useMaster: true, transaction: null });
        expect(current.config).toEqual(currentConfig);
        expect(current.enabled).toBe(true);
        expect(Date.now()).toBeLessThan(due);
        await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(due + 500));
        const plugin = app.pm.get('workflow');
        await waitForFastAssertion(() => {
          expect(plugin.events).toHaveLength(0);
          expect(plugin.preparing).toBeFalsy();
          expect(plugin.pending).toHaveLength(0);
          expect(plugin.executing).toBeFalsy();
        });
        const beforeRestart = await workflow.getExecutions({ order: [['id', 'ASC']] });
        expect(beforeRestart.map((execution) => Date.parse(execution.context.date) - due)).toEqual(expectedDates);
        const beforeRows = await app.db.getRepository('staticLifecycleResults').find();
        expect(beforeRows.map((row) => row.label)).toEqual(expectedDates.map(() => 'Current primary schedule'));
        if (startOffset) {
          await app.stop();
          await app.start();
          expect(Date.now()).toBeLessThan(due + startOffset);
          await waitForFastAssertion(async () => {
            const executions = await workflow.getExecutions();
            expect(executions.map((execution) => Date.parse(execution.context.date))).toEqual([due + startOffset]);
            const rows = await app.db.getRepository('staticLifecycleResults').find();
            expect(rows.map((row) => row.label)).toEqual(['Current primary schedule']);
          });
        }
        await workflow.reload({ useMaster: true, transaction: null });
        expect([workflow.executed, workflow.allExecuted]).toEqual([1, 1]);
      } finally {
        await workflow.update({ enabled: false });
      }
    },
  );

  it('continues a still-valid occurrence using the primary repeat instead of its cached repeat', async () => {
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current primary repeat' } } },
    });
    const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    try {
      await workflow.update({
        enabled: true,
        config: {
          mode: 0,
          startsOn: new Date(due).toISOString(),
          endsOn: new Date(due + 4000).toISOString(),
          repeat: 2000,
        },
      });
      await app.db.getModel('workflows').update(
        {
          config: {
            mode: 0,
            startsOn: new Date(due).toISOString(),
            endsOn: new Date(due + 3000).toISOString(),
            repeat: 3000,
          },
        },
        { where: { id: workflow.id }, hooks: false },
      );
      expect(workflow.config.repeat).toBe(2000);
      expect(Date.now()).toBeLessThan(due);
      await waitForFastAssertion(() => expect(Date.now()).toBeGreaterThan(due + 3600), 10000);
      const plugin = app.pm.get('workflow');
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      const executions = await workflow.getExecutions({ order: [['id', 'ASC']] });
      expect(executions.map((execution) => Date.parse(execution.context.date) - due)).toEqual([0, 3000]);
      const rows = await app.db.getRepository('staticLifecycleResults').find();
      expect(rows.map((row) => row.label)).toEqual(['Current primary repeat', 'Current primary repeat']);
      await workflow.reload({ useMaster: true, transaction: null });
      expect([workflow.config.repeat, workflow.executed, workflow.allExecuted]).toEqual([3000, 2, 2]);
    } finally {
      await workflow.update({ enabled: false });
    }
  });

  it('restores a stopped timer discovered after the generic startup snapshot', async () => {
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current static task' } } },
    });
    await app.stop();
    const due = Math.ceil((Date.now() + 4000) / 1000) * 1000;
    await app.db
      .getCollection('workflows')
      .model.update(
        { config: { mode: 0, startsOn: new Date(due).toISOString() } },
        { where: { id: workflow.id }, hooks: false },
      );
    const find = repository.find.bind(repository);
    let enabled = false;
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      if (options?.filter?.enabled === true && !options.filter.type) {
        expect(rows.some((row) => row.id === workflow.id)).toBe(false);
        await app.db
          .getCollection('workflows')
          .model.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });
        enabled = true;
      }
      return rows;
    });
    try {
      await app.start();
    } finally {
      discovery.mockRestore();
    }
    expect(enabled).toBe(true);
    expect(app.pm.get('workflow').enabledCache.has(workflow.id)).toBe(false);
    expect(Date.now()).toBeLessThan(due);
    await app.stop();
    await app.start();
    expect(Date.now()).toBeLessThan(due);
    await waitForFastAssertion(async () => {
      expect(await workflow.countExecutions()).toBe(1);
      const rows = await app.db.getRepository('staticLifecycleResults').find();
      expect(rows.map((row) => row.label)).toEqual(['Current static task']);
    });
    await waitForWorkflowIdle(app);
  });

  it('discards a stopped deadline read for an independently discovered static task', async () => {
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current static task' } } },
    });
    await app.stop();
    const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
    await app.db
      .getCollection('workflows')
      .model.update(
        { config: { mode: 0, startsOn: new Date(due).toISOString() } },
        { where: { id: workflow.id }, hooks: false },
      );
    const find = repository.find.bind(repository);
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      if (options?.filter?.enabled === true && !options.filter.type) {
        expect(rows.some((row) => row.id === workflow.id)).toBe(false);
        await app.db
          .getCollection('workflows')
          .model.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });
      }
      return rows;
    });
    try {
      await app.start();
    } finally {
      discovery.mockRestore();
    }
    const plugin = app.pm.get('workflow');
    expect(plugin.enabledCache.has(workflow.id)).toBe(false);
    expect(Date.now()).toBeLessThan(due);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let checked = false;
    let pending: Promise<void> | undefined;
    const mode = plugin.triggers.get('schedule').modes.get(0);
    const trigger = mode.trigger.bind(mode);
    const observe = vi.spyOn(mode, 'trigger').mockImplementation((...args) => {
      pending = trigger(...args);
      return pending;
    });
    const findOne = repository.findOne.bind(repository);
    const authority = vi.spyOn(repository, 'findOne').mockImplementation(async (options) => {
      const result = await findOne(options);
      if (options?.filter?.enabled === true && options.filter['config.mode'] === 0) {
        expect(result.id).toBe(workflow.id);
        checked = true;
        await hold;
      }
      return result;
    });
    try {
      await waitForFastAssertion(async () => expect(checked).toBe(true));
      const oldCall = pending;
      expect(oldCall).toBeDefined();
      await app.stop();
      // A fresh startup must not legitimately reschedule the original due second.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due + 1000 - Date.now()) + 10));
      expect(Math.floor(Date.now() / 1000) * 1000).toBeGreaterThan(due);
      await app.start();
      release();
      await oldCall;
      await waitForFastAssertion(() => expect(plugin.preparing).toBeFalsy());
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('staticLifecycleResults').count()).toBe(0);

      const current = await repository.findOne({ filterByTk: workflow.id });
      const nextDue = Math.ceil((Date.now() + 200) / 1000) * 1000;
      await current.update({ config: { mode: 0, startsOn: new Date(nextDue).toISOString() } });
      await waitForFastAssertion(async () => {
        expect(await workflow.countExecutions()).toBe(1);
        const rows = await app.db.getRepository('staticLifecycleResults').find();
        expect(rows.map((row) => row.label)).toEqual(['Current static task']);
      });
      await waitForWorkflowIdle(app);
    } finally {
      release();
      await pending;
      authority.mockRestore();
      observe.mockRestore();
    }
  });

  it('logs a deadline SQL failure and permits an explicit new schedule after recovery', async () => {
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current static task' } } },
    });
    const plugin = app.pm.get('workflow');
    const errors = vi.spyOn(plugin.getLogger(workflow.id), 'error');
    const table = app.db.getCollection('workflows').model.getTableName();
    const queryInterface = app.db.sequelize.getQueryInterface();
    const unavailable = 'unavailableStaticWorkflowFacts';
    let renamed = false;
    try {
      const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
      await workflow.update({ enabled: true, config: { mode: 0, startsOn: new Date(due).toISOString() } });
      await queryInterface.renameTable(table, unavailable);
      renamed = true;
      expect(Date.now()).toBeLessThan(due);
      await waitForFastAssertion(async () => {
        const failure = errors.mock.calls.find(([message]) => message === 'failed to trigger static schedule');
        expect(failure?.[1]).toMatchObject({ name: 'SequelizeDatabaseError' });
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('staticLifecycleResults').count()).toBe(0);
    } finally {
      if (renamed) await queryInterface.renameTable(unavailable, table);
      errors.mockRestore();
    }

    const nextDue = Math.ceil((Date.now() + 200) / 1000) * 1000;
    await workflow.update({ enabled: true, config: { mode: 0, startsOn: new Date(nextDue).toISOString() } });
    await waitForFastAssertion(async () => {
      const rows = await app.db.getRepository('staticLifecycleResults').find();
      expect(rows.map((row) => row.label)).toEqual(['Current static task']);
    });
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions()).toBe(1);
  });

  it('discards a deadline read completed before the local task was disabled', async () => {
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current static task' } } },
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let checked = false;
    let delivered = false;
    const findOne = repository.findOne.bind(repository);
    const authority = vi.spyOn(repository, 'findOne').mockImplementation(async (options) => {
      const result = await findOne(options);
      if (options?.filter?.enabled === true && options.filter['config.mode'] === 0) {
        expect(result.id).toBe(workflow.id);
        checked = true;
        await hold;
        delivered = true;
      }
      return result;
    });
    try {
      const due = Math.ceil((Date.now() + 200) / 1000) * 1000;
      await workflow.update({ enabled: true, config: { mode: 0, startsOn: new Date(due).toISOString() } });
      await waitForFastAssertion(async () => expect(checked).toBe(true));
      await workflow.update({ enabled: false });
      release();
      await waitForFastAssertion(async () => expect(delivered).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('staticLifecycleResults').count()).toBe(0);
    } finally {
      release();
      authority.mockRestore();
    }
  });

  it('rejects a persisted disable at the deadline even without a local save event', async () => {
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current static task' } } },
    });
    const due = Math.ceil((Date.now() + 1000) / 1000) * 1000;
    await workflow.update({ enabled: true, config: { mode: 0, startsOn: new Date(due).toISOString() } });
    // Simulate another writer: preserve the local timer and cached enabled object.
    await app.db
      .getCollection('workflows')
      .model.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
    expect(workflow.enabled).toBe(true);
    expect((await repository.findOne({ filterByTk: workflow.id })).enabled).toBe(false);
    expect(Date.now()).toBeLessThan(due);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 300));
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions()).toBe(0);
    expect(await app.db.getRepository('staticLifecycleResults').count()).toBe(0);

    const current = await repository.findOne({ filterByTk: workflow.id });
    const nextDue = Math.ceil((Date.now() + 200) / 1000) * 1000;
    await current.update({ enabled: true, config: { mode: 0, startsOn: new Date(nextDue).toISOString() } });
    await waitForFastAssertion(async () => {
      const rows = await app.db.getRepository('staticLifecycleResults').find();
      expect(rows.map((row) => row.label)).toEqual(['Current static task']);
    });
    await waitForWorkflowIdle(app);
    expect(await workflow.countExecutions()).toBe(1);
  });

  it.each([
    ['static', false],
    ['static', true],
    ['generic', false],
    ['generic', true],
  ])('discards disabled %s startup results with immediate re-enable: %s', async (loader, reEnable) => {
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: { type: 'schedule', enabled: false, config: { mode: 0 } },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticLifecycleResults', params: { values: { label: 'Current static task' } } },
    });
    await app.stop();
    const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    await app.db
      .getCollection('workflows')
      .model.update(
        { enabled: true, config: { mode: 0, startsOn: new Date(due).toISOString() } },
        { where: { id: workflow.id }, hooks: false },
      );

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let discovered = false;
    const find = repository.find.bind(repository);
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      const filter = options?.filter;
      if (filter?.enabled === true && (loader === 'static' ? filter['config.mode'] === 0 : !filter.type)) {
        expect(rows.map((row) => row.id)).toEqual([workflow.id]);
        discovered = true;
        await hold;
      }
      return rows;
    });
    const starting = app.start();
    try {
      await waitForFastAssertion(async () => expect(discovered).toBe(true));
      const current = await repository.findOne({ filterByTk: workflow.id, useMaster: true, transaction: null });
      expect(current.enabled).toBe(true);
      await current.update({ enabled: false });
      let nextDue: number;
      if (reEnable) {
        nextDue = due + 1500;
        await current.update({ enabled: true, config: { mode: 0, startsOn: new Date(nextDue).toISOString() } });
      }
      release();
      await starting;
      expect(Date.now()).toBeLessThan(due);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 300));
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('staticLifecycleResults').count()).toBe(0);

      if (!reEnable) {
        nextDue = Math.ceil((Date.now() + 200) / 1000) * 1000;
        await current.update({ enabled: true, config: { mode: 0, startsOn: new Date(nextDue).toISOString() } });
      }
      await waitForFastAssertion(async () => {
        const rows = await app.db.getRepository('staticLifecycleResults').find();
        expect(rows.map((row) => row.label)).toEqual(['Current static task']);
      });
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(1);
    } finally {
      release();
      try {
        await starting;
      } finally {
        discovery.mockRestore();
      }
    }
  });
});
