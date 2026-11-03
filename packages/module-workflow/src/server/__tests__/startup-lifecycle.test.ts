import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from './utils';

describe('workflow initial registration lifecycle', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not restore a stopped startup registration after another startup sees it disabled', async () => {
    app = await createMockServer({
      skipStart: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    app.db.collection({
      name: 'startupLifecycleSources',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'revision', type: 'integer' },
      ],
    });
    app.db.collection({
      name: 'startupLifecycleResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'label', type: 'string' },
      ],
    });
    await app.db.sync();
    const repository = app.db.getRepository('workflows');
    const workflow = await repository.create({
      values: {
        type: 'collection',
        enabled: false,
        config: { collection: 'startupLifecycleSources', mode: 1 },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'startupLifecycleResults', params: { values: { label: 'Current B task' } } },
    });
    await app.db
      .getCollection('workflows')
      .model.update({ enabled: true }, { where: { id: workflow.id }, hooks: false });
    const plugin = app.pm.get('workflow');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let discovered = false;
    const find = repository.find.bind(repository);
    const discovery = vi.spyOn(repository, 'find').mockImplementation(async (options) => {
      const rows = await find(options);
      if (!discovered && options?.filter?.enabled === true && !options.filter.type) {
        expect(rows.map((row) => row.id)).toEqual([workflow.id]);
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
        .model.update({ enabled: false }, { where: { id: workflow.id }, hooks: false });
      await app.start();
      expect(plugin.enabledCache.has(workflow.id)).toBe(false);
      release();
      await starting;
      expect((await repository.findOne({ filterByTk: workflow.id })).enabled).toBe(false);
      const sources = app.db.getRepository('startupLifecycleSources');
      await sources.create({ values: { tenantId: 'B', revision: 1 } });
      await waitForFastAssertion(() => {
        expect(plugin.events).toHaveLength(0);
        expect(plugin.preparing).toBeFalsy();
        expect(plugin.pending).toHaveLength(0);
        expect(plugin.executing).toBeFalsy();
      });
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('startupLifecycleResults').count()).toBe(0);
      expect((await sources.find()).map((row) => [row.tenantId, row.revision])).toEqual([['B', 1]]);

      const current = await repository.findOne({ filterByTk: workflow.id });
      await current.update({ enabled: true });
      await sources.create({ values: { tenantId: 'B', revision: 2 } });
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
        expect(executions[0].context.data.revision).toBe(2);
        const rows = await app.db.getRepository('startupLifecycleResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([['B', 'Current B task']]);
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
