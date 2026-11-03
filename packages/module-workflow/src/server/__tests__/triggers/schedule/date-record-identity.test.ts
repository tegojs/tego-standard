import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../utils';

describe('date schedule record identity', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('cancels only the saved record when another owner has a delimiter in its string key', async () => {
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
      name: 'stringScheduleSources',
      tenancy: 'tenantScoped',
      autoGenId: false,
      filterTargetKey: 'taskKey',
      fields: [
        { name: 'taskKey', type: 'string', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'scheduledAt', type: 'date' },
      ],
    });
    app.db.collection({
      name: 'stringScheduleResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'label', type: 'string' },
      ],
    });
    await app.db.sync();
    await app.db.getCollection('tenants').model.bulkCreate([
      { id: 'B', enabled: true, path: '/B/' },
      { id: 'H', enabled: true, path: '/H/' },
    ]);
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        type: 'schedule',
        enabled: false,
        config: { mode: 1, collection: 'stringScheduleSources', startsOn: { field: 'scheduledAt' } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'stringScheduleResults', params: { values: { label: 'String key task' } } },
    });
    const due = Math.ceil((Date.now() + 5000) / 1000) * 1000;
    await app.db.getCollection('stringScheduleSources').model.bulkCreate([
      { taskKey: 'a', tenantId: 'B', scheduledAt: new Date(due) },
      { taskKey: 'a@b', tenantId: 'H', scheduledAt: new Date(due) },
      { taskKey: 'a@b@c', tenantId: 'H', scheduledAt: new Date(due) },
    ]);
    const plugin = app.pm.get('workflow');
    const mode = plugin.triggers.get('schedule').modes.get(1);
    const scans: Promise<void>[] = [];
    const inspect = mode.inspect.bind(mode);
    const observe = vi.spyOn(mode, 'inspect').mockImplementation((...args) => {
      const result = inspect(...args);
      scans.push(result);
      return result;
    });
    try {
      await workflow.update({ enabled: true });
      await Promise.all(scans);
      expect(Date.now()).toBeLessThan(due);
      await app.db.getRepository('stringScheduleSources').update({
        filterByTk: 'a',
        values: { scheduledAt: null },
      });
      expect(Date.now()).toBeLessThan(due);
      await waitForFastAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.map((row) => [row.context.data.taskKey, row.tenantId]).sort()).toEqual([
          ['a@b', 'H'],
          ['a@b@c', 'H'],
        ]);
        const rows = await app.db.getRepository('stringScheduleResults').find();
        expect(rows.map((row) => [row.tenantId, row.label])).toEqual([
          ['H', 'String key task'],
          ['H', 'String key task'],
        ]);
      });
      await waitForWorkflowIdle(app);
      const sources = await app.db.getRepository('stringScheduleSources').find({ sort: 'taskKey' });
      expect(sources.map((row) => [row.taskKey, row.tenantId, row.scheduledAt?.getTime() ?? null])).toEqual([
        ['a', 'B', null],
        ['a@b', 'H', due],
        ['a@b@c', 'H', due],
      ]);
    } finally {
      await Promise.allSettled(scans);
      observe.mockRestore();
    }
  });
});
