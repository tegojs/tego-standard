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
      if (options?.filter?.enabled === true && options.filter['config.mode'] === 1) {
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
