import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../utils';

describe('collection workflow listener lifecycle', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    app.db.collection({
      name: 'listenerLifecycleSources',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'revision', type: 'integer' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    app.db.collection({
      name: 'listenerLifecycleResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'label', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await app.db.sync();
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([false, true])('rejects a removed listener after its condition SQL with re-enable: %s', async (reEnable) => {
    const sources = app.db.getRepository('listenerLifecycleSources');
    const source = await sources.create({ values: { title: 'ready', revision: 0, tenantId: 'B' }, hooks: false });
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        enabled: false,
        type: 'collection',
        config: { collection: 'listenerLifecycleSources', mode: 2, condition: { $and: [{ title: 'ready' }] } },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'listenerLifecycleResults', params: { values: { label: 'Generated for B' } } },
    });
    await workflow.update({ enabled: true });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let checked = false;
    const count = sources.count.bind(sources);
    const condition = vi.spyOn(sources, 'count').mockImplementation(async (options) => {
      const matched = await count(options);
      expect(matched).toBe(1);
      checked = true;
      await hold;
      return matched;
    });
    const updating = sources.update({ filterByTk: source.id, values: { revision: 1 } });
    try {
      await waitForFastAssertion(async () => expect(checked).toBe(true));
      await workflow.update({ enabled: false });
      if (reEnable) await workflow.update({ enabled: true });
      release();
      await updating;
      await waitForWorkflowIdle(app);
      expect(await workflow.countExecutions()).toBe(0);
      expect(await app.db.getRepository('listenerLifecycleResults').count()).toBe(0);
      expect((await sources.findOne({ filterByTk: source.id })).revision).toBe(1);
    } finally {
      release();
      try {
        await updating;
      } finally {
        condition.mockRestore();
      }
    }

    if (!reEnable) await workflow.update({ enabled: true });
    await sources.update({ filterByTk: source.id, values: { revision: 2 } });
    await waitForFastAssertion(async () => {
      const rows = await app.db.getRepository('listenerLifecycleResults').find();
      expect(rows.map((row) => ({ label: row.label, tenantId: row.tenantId }))).toEqual([
        { label: 'Generated for B', tenantId: 'B' },
      ]);
    });
    await waitForWorkflowIdle(app);
    const executions = await workflow.getExecutions();
    expect(executions.map((execution) => execution.tenantId)).toEqual(['B']);
    expect(executions[0].context.data.revision).toBe(2);
  });

  it.each([false, true])('rejects a removed asynchronous listener at commit with re-enable: %s', async (reEnable) => {
    const sources = app.db.getRepository('listenerLifecycleSources');
    const results = app.db.getRepository('listenerLifecycleResults');
    const workflow = await app.db.getRepository('workflows').create({
      values: {
        enabled: false,
        sync: false,
        type: 'collection',
        config: { collection: 'listenerLifecycleSources', mode: 1 },
      },
    });
    await workflow.createNode({
      type: 'create',
      config: { collection: 'listenerLifecycleResults', params: { values: { label: 'Committed for B' } } },
    });
    await workflow.update({ enabled: true });
    const transaction = await app.db.sequelize.transaction();
    try {
      await sources.create({ values: { title: 'removed listener', tenantId: 'B' }, transaction });
      expect(await workflow.countExecutions({ transaction })).toBe(0);
      expect(await results.count({ transaction })).toBe(0);
      await workflow.update({ enabled: false }, { transaction });
      if (reEnable) await workflow.update({ enabled: true }, { transaction });
      await transaction.commit();
    } finally {
      if (!transaction.finished) await transaction.rollback();
    }
    await waitForWorkflowIdle(app);
    expect(await sources.count()).toBe(1);
    expect(await workflow.countExecutions()).toBe(0);
    expect(await results.count()).toBe(0);

    if (!reEnable) await workflow.update({ enabled: true });
    await sources.create({ values: { title: 'current listener', tenantId: 'B' } });
    await waitForFastAssertion(async () => {
      const rows = await results.find();
      expect(rows.map((row) => ({ label: row.label, tenantId: row.tenantId }))).toEqual([
        { label: 'Committed for B', tenantId: 'B' },
      ]);
    });
    await waitForWorkflowIdle(app);
    const executions = await workflow.getExecutions();
    expect(executions).toHaveLength(1);
    expect(executions[0].tenantId).toBe('B');
    expect(executions[0].context.data.title).toBe('current listener');
  });
});
