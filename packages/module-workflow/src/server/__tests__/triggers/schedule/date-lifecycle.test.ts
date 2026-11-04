import { createMockServer, type MockServer } from '@tachybase/test';

import type WorkflowPlugin from '../../../Plugin';
import type DateFieldScheduleTrigger from '../../../triggers/ScheduleTrigger/DateFieldScheduleTrigger';
import { waitForFastAssertion, waitForWorkflowIdle } from '../../utils';

describe('date schedule discovery lifecycle', () => {
  let app: MockServer;

  beforeEach(async () => {
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
    app.db.collection({
      name: 'dateLifecycleDocuments',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'scheduledAt', type: 'date' },
      ],
    });
    app.db.collection({
      name: 'dateLifecycleResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'label', type: 'string' },
      ],
    });
    await app.db.sync();
    await app.db.getCollection('tenants').model.create({ id: 'B', enabled: true, path: '/B/' });
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it('discards a pre-stop reload list after restart selects another tenant source', async () => {
    app.db.collection({
      name: 'replacementDateLifecycleDocuments',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'scheduledAt', type: 'date' },
      ],
    });
    await app.db.sync();
    await app.db.getCollection('tenants').model.create({ id: 'C', enabled: true, path: '/C/' });
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'dateLifecycleDocuments', startsOn: { field: 'scheduledAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'dateLifecycleResults', params: { values: { label: 'Restarted source task' } } },
    });
    await app.stop();
    const due = Math.ceil((Date.now() + 6000) / 1000) * 1000;
    await app.db
      .getCollection('dateLifecycleDocuments')
      .model.create({ id: 1, tenantId: 'C', scheduledAt: new Date(due) });
    await app.db
      .getCollection('replacementDateLifecycleDocuments')
      .model.create({ id: 1, tenantId: 'B', scheduledAt: new Date(due) });
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const installed = plugin.triggers.get('schedule') as unknown as { modes: Map<number, DateFieldScheduleTrigger> };
    const mode = installed.modes.get(1)!;
    const reloads: Promise<void>[] = [];
    const reload = mode.reload.bind(mode);
    const observeReload = vi.spyOn(mode, 'reload').mockImplementation(() => {
      const result = reload();
      reloads.push(result);
      return result;
    });
    const inspections: Promise<void>[] = [];
    const inspect = mode.inspect.bind(mode);
    const observeInspect = vi.spyOn(mode, 'inspect').mockImplementation((...args) => {
      const result = inspect(...args);
      inspections.push(result);
      return result;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let enabled = false;
    let discovered = false;
    const find = repository.find.bind(repository);
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      if (!enabled && options?.filter?.enabled === true && !options.filter.type) {
        expect(rows.some((row) => row.id === workflow.id)).toBe(false);
        await app.db
          .getCollection('workflows')
          .model.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });
        enabled = true;
      } else if (!discovered && options?.filter?.enabled === true && options.filter['config.mode'] === 1) {
        expect(rows.map((row) => row.config.collection)).toEqual(['dateLifecycleDocuments']);
        discovered = true;
        await hold;
      }
      return rows;
    });
    try {
      await app.start();
      await waitForFastAssertion(() => expect(discovered).toBe(true));
      expect(plugin.enabledCache.has(workflow.id)).toBe(false);
      const oldReload = reloads[0];
      expect(oldReload).toBeDefined();
      await app.stop();
      // A different writer changes only this fixture's persisted schedule configuration.
      await app.db
        .getCollection('workflows')
        .model.update(
          { config: { mode: 1, collection: 'replacementDateLifecycleDocuments', startsOn: { field: 'scheduledAt' } } },
          { where: { id: workflow.id }, hooks: false },
        );
      await app.start();
      await mode.reload();
      await Promise.all(reloads.slice(1));
      await Promise.all(inspections);
      expect(plugin.enabledCache.get(workflow.id).config.collection).toBe('replacementDateLifecycleDocuments');
      expect(Date.now()).toBeLessThan(due);
      release();
      await oldReload;
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
        expect(executions[0].context.data.tenantId).toBe('B');
        const rows = await app.db.getRepository('dateLifecycleResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Restarted source task']]);
      });
      await waitForWorkflowIdle(app);
    } finally {
      release();
      await Promise.allSettled(reloads);
      await Promise.allSettled(inspections);
      discovery.mockRestore();
      observeReload.mockRestore();
      observeInspect.mockRestore();
    }
  });

  it('keeps the latest source when overlapping reload lists return out of order', async () => {
    app.db.collection({
      name: 'replacementDateLifecycleDocuments',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'scheduledAt', type: 'date' },
      ],
    });
    await app.db.sync();
    await app.db.getCollection('tenants').model.create({ id: 'C', enabled: true, path: '/C/' });
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'dateLifecycleDocuments', startsOn: { field: 'scheduledAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'dateLifecycleResults', params: { values: { label: 'Latest source task' } } },
    });
    await app.stop();
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const installed = plugin.triggers.get('schedule') as unknown as { modes: Map<number, DateFieldScheduleTrigger> };
    const mode = installed.modes.get(1)!;
    const startupReloads: Promise<void>[] = [];
    const reload = mode.reload.bind(mode);
    const observeReload = vi.spyOn(mode, 'reload').mockImplementation(() => {
      const result = reload();
      startupReloads.push(result);
      return result;
    });
    try {
      await app.start();
      await Promise.all(startupReloads);
    } finally {
      observeReload.mockRestore();
    }
    const due = Math.ceil((Date.now() + 5000) / 1000) * 1000;
    await app.db
      .getCollection('dateLifecycleDocuments')
      .model.create({ id: 1, tenantId: 'C', scheduledAt: new Date(due) });
    await app.db
      .getCollection('replacementDateLifecycleDocuments')
      .model.create({ id: 1, tenantId: 'B', scheduledAt: new Date(due) });
    await app.db
      .getCollection('workflows')
      .model.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let discovered = false;
    const find = repository.find.bind(repository);
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      if (!discovered && options?.filter?.enabled === true && options.filter['config.mode'] === 1) {
        expect(rows.map((row) => row.config.collection)).toEqual(['dateLifecycleDocuments']);
        discovered = true;
        await hold;
      }
      return rows;
    });
    const oldReload = mode.reload();
    try {
      await waitForFastAssertion(() => expect(discovered).toBe(true));
      await app.db
        .getCollection('workflows')
        .model.update(
          { config: { mode: 1, collection: 'replacementDateLifecycleDocuments', startsOn: { field: 'scheduledAt' } } },
          { where: { id: workflow.id }, hooks: false },
        );
      await mode.reload();
      expect(Date.now()).toBeLessThan(due);
      release();
      await oldReload;
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
        expect(executions[0].context.data.tenantId).toBe('B');
        const rows = await app.db.getRepository('dateLifecycleResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Latest source task']]);
      });
      await waitForWorkflowIdle(app);
    } finally {
      release();
      await oldReload;
      discovery.mockRestore();
    }
  });

  it.each([false, true])(
    'retains the next numeric repeat when the enabled read crosses a second (controlled early reference: %s)',
    async (earlyReference) => {
      const repository = app.db.getRepository('workflows');
      const workflow = await repository.create({
        values: {
          type: 'schedule',
          enabled: false,
          config: {
            mode: 1,
            collection: 'dateLifecycleDocuments',
            startsOn: { field: 'scheduledAt' },
            repeat: 1000,
            endsOn: { field: 'scheduledAt', offset: 2 },
          },
        },
      });
      await workflow.createNode({
        type: 'create',
        config: { collection: 'dateLifecycleResults', params: { values: { label: 'Repeated date task' } } },
      });
      await workflow.update({ enabled: true });
      const plugin = app.pm.get('workflow') as WorkflowPlugin;
      const installed = plugin.triggers.get('schedule') as unknown as { modes: Map<number, DateFieldScheduleTrigger> };
      const mode = installed.modes.get(1)!;
      const due = Math.ceil((Date.now() + 2000) / 1000) * 1000;
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let checked = false;
      let enteredAt: number;
      const pending: Promise<void>[] = [];
      const trigger = mode.trigger.bind(mode);
      const observe = vi.spyOn(mode, 'trigger').mockImplementation((...args) => {
        enteredAt ??= Date.now();
        let result: ReturnType<typeof trigger>;
        if (earlyReference && pending.length === 0) {
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
        pending.push(result);
        return result;
      });
      const findOne = repository.findOne.bind(repository);
      const authority = vi.spyOn(repository, 'findOne').mockImplementation(async (options) => {
        const result = await findOne(options);
        if (!checked && !options?.fields && options?.filter?.enabled === true && options.filter['config.mode'] === 1) {
          expect(result.id).toBe(workflow.id);
          checked = true;
          await hold;
        }
        return result;
      });
      try {
        await app.db.getRepository('dateLifecycleDocuments').create({
          values: { tenantId: 'B', scheduledAt: new Date(due) },
        });
        await waitForFastAssertion(() => expect(checked).toBe(true));
        expect(enteredAt).toBeLessThan(due + 1000);
        expect(Date.now()).toBeLessThan(due + 1000);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, due + 1100 - Date.now())));
        expect(Date.now()).toBeGreaterThanOrEqual(due + 1100);
        expect(Date.now()).toBeLessThan(due + 1900);
        release();
        await waitForFastAssertion(async () => {
          const executions = await workflow.getExecutions({ order: [['createdAt', 'ASC']] });
          expect(executions.map((execution) => [execution.tenantId, Date.parse(execution.context.date)])).toEqual([
            ['B', due],
            ['B', due + 2000],
          ]);
          const rows = await app.db.getRepository('dateLifecycleResults').find();
          expect(rows.map((row) => [row.tenantId, row.label])).toEqual([
            ['B', 'Repeated date task'],
            ['B', 'Repeated date task'],
          ]);
        }, 5000);
        await waitForWorkflowIdle(app);
      } finally {
        release();
        mode.off(workflow);
        await Promise.allSettled(pending);
        authority.mockRestore();
        observe.mockRestore();
      }
    },
  );

  it('discards a stopped deadline read for an independently discovered tenant task', async () => {
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'dateLifecycleDocuments', startsOn: { field: 'scheduledAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'dateLifecycleResults', params: { values: { label: 'Current date task' } } },
    });
    await app.stop();
    const due = Math.ceil((Date.now() + 3000) / 1000) * 1000;
    const document = await app.db
      .getCollection('dateLifecycleDocuments')
      .model.create({ tenantId: 'B', scheduledAt: new Date(due) });
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
    const plugin = app.pm.get('workflow') as WorkflowPlugin;
    const installed = plugin.triggers.get('schedule') as unknown as { modes: Map<number, DateFieldScheduleTrigger> };
    const mode = installed.modes.get(1)!;
    let pending: ReturnType<DateFieldScheduleTrigger['trigger']> | undefined;
    const trigger = mode.trigger.bind(mode);
    const observe = vi.spyOn(mode, 'trigger').mockImplementation((...args) => {
      pending = trigger(...args);
      return pending;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let checked = false;
    const findOne = repository.findOne.bind(repository);
    const authority = vi.spyOn(repository, 'findOne').mockImplementation(async (options) => {
      const result = await findOne(options);
      if (!options?.fields && options?.filter?.enabled === true && options.filter['config.mode'] === 1) {
        expect(result.id).toBe(workflow.id);
        checked = true;
        await hold;
      }
      return result;
    });
    try {
      try {
        await app.start();
      } finally {
        discovery.mockRestore();
      }
      expect(plugin.enabledCache.has(workflow.id)).toBe(false);
      expect(Date.now()).toBeLessThan(due);
      await waitForFastAssertion(() => expect(checked).toBe(true));
      const oldCall = pending;
      expect(oldCall).toBeDefined();
      await app.stop();
      // The restarted scanner must not legitimately schedule the original due second.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due + 1000 - Date.now()) + 10));
      expect(Math.floor(Date.now() / 1000) * 1000).toBeGreaterThan(due);
      await app.start();
      release();
      await oldCall;
      const queue = plugin as unknown as { preparing: Promise<void> | null };
      await waitForFastAssertion(() => expect(queue.preparing).toBeFalsy());
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('dateLifecycleResults').count()).toBe(0);

      const nextDue = Math.ceil((Date.now() + 200) / 1000) * 1000;
      await app.db.getRepository('dateLifecycleDocuments').update({
        filterByTk: document.id,
        values: { scheduledAt: new Date(nextDue) },
      });
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
        expect(executions[0].context.data.tenantId).toBe('B');
        const rows = await app.db.getRepository('dateLifecycleResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Current date task']]);
      });
      await waitForWorkflowIdle(app);
    } finally {
      release();
      await pending;
      discovery.mockRestore();
      authority.mockRestore();
      observe.mockRestore();
    }
  });
});
