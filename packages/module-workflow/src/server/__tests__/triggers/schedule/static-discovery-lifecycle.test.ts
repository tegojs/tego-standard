import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../utils';

describe('static schedule initial discovery lifecycle', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('discards an initial startup list delivered after stop and a new startup', async () => {
    app = await createMockServer({
      skipStart: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    app.db.collection({ name: 'staticDiscoveryResults', fields: [{ name: 'label', type: 'string' }] });
    await app.db.sync();
    const repository = app.db.getRepository('workflows');
    const oldDue = Math.ceil((Date.now() + 4000) / 1000) * 1000;
    const newDue = oldDue + 2000;
    const workflow = await repository.create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 0, startsOn: new Date(oldDue).toISOString() },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'staticDiscoveryResults', params: { values: { label: 'Current startup task' } } },
    });
    const plugin = app.pm.get('workflow');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let discovered = false;
    const find = repository.find.bind(repository);
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      if (options?.filter?.enabled === true && !options.filter.type) {
        expect(rows.some((row) => row.id === workflow.id)).toBe(false);
        await app.db
          .getCollection('workflows')
          .model.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });
      } else if (!discovered && options?.filter?.enabled === true && options.filter['config.mode'] === 0) {
        expect(rows.map((row) => row.config.startsOn)).toEqual([new Date(oldDue).toISOString()]);
        discovered = true;
        await hold;
      }
      return rows;
    });
    const starting = app.start();
    try {
      await waitForFastAssertion(() => expect(discovered).toBe(true));
      expect(plugin.enabledCache.has(workflow.id)).toBe(false);
      await app.stop();
      expect(await app.isStarted()).toBe(false);
      await app.db
        .getCollection('workflows')
        .model.update(
          { enabled: false, config: { mode: 0, startsOn: new Date(newDue).toISOString() } },
          { where: { id: workflow.id }, hooks: false },
        );
      await app.start();
      expect(plugin.enabledCache.has(workflow.id)).toBe(false);
      expect(Date.now()).toBeLessThan(oldDue);
      release();
      await starting;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, oldDue - Date.now()) + 300));
      expect(Date.now()).toBeLessThan(newDue);
      await waitForFastAssertion(() => expect(plugin.preparing).toBeFalsy());
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('staticDiscoveryResults').count()).toBe(0);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => new Date(execution.context.date).getTime())).toEqual([newDue]);
        const rows = await app.db.getRepository('staticDiscoveryResults').find();
        expect(rows.map((row) => row.label)).toEqual(['Current startup task']);
      });
      await waitForWorkflowIdle(app);
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
