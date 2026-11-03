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
