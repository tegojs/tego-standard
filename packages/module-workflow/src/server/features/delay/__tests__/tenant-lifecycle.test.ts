import { createMockServer, type MockServer } from '@tachybase/test';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../../__tests__/utils';
import { EXECUTION_STATUS, JOB_STATUS } from '../../../constants';

describe('tenant delay timer failure lifecycle', () => {
  let app: MockServer;
  let plugin;
  let instruction;

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    plugin = app.pm.get('workflow');
    instruction = plugin.instructions.get('delay');
    app.db.collection({ name: 'delayFailureSources', fields: [{ name: 'label', type: 'string' }] });
    app.db.collection({
      name: 'delayFailureResults',
      tenancy: 'tenantScoped',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'label', type: 'string' },
      ],
    });
    await app.db.sync();
  });

  beforeEach(async () => {
    await waitForWorkflowIdle(app);
    await app.db.getCollection('delayFailureResults').model.destroy({ where: {} });
  });

  afterAll(() => app.destroy());

  async function createPendingTenantDelay(duration = 1000) {
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', enabled: true, config: { collection: 'delayFailureSources', mode: 1 } },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration, endStatus: JOB_STATUS.RESOLVED },
    });
    const consumer = await workflow.createNode({
      type: 'create',
      upstreamId: delay.id,
      config: { collection: 'delayFailureResults', params: { values: { label: 'Recovered B delay' } } },
    });
    await delay.setDownstream(consumer);
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: {},
      tenantId: 'B',
      tenantContext: {
        currentTenant: { id: 'B' },
        currentTenantId: 'B',
        currentTenancyMode: 'tenantScoped',
        currentTenantDescendantIds: [],
        currentLegacyDataTenantIds: [],
      },
    });
    const pending = await execution.createJob({
      nodeId: delay.id,
      nodeKey: delay.key,
      status: JOB_STATUS.PENDING,
      result: null,
    });
    pending.node = delay;
    return { execution, pending, delay };
  }

  it.each(['missing execution', 'SQL failure'])(
    'finishes a real due timer after %s without generating tenant data',
    async (failure) => {
      const { execution, pending } = await createPendingTenantDelay();
      const model = app.db.getCollection('executions').model;
      let faultInjected = false;
      const errors = vi.spyOn(plugin.getLogger('dispatcher'), 'error');
      const original = instruction.trigger.bind(instruction);
      const outcomes: Promise<{ error?: unknown }>[] = [];
      // Observe real callback settlement so a RED rejection can be inspected and cleaned up.
      const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
        const result = original(job);
        outcomes.push(
          Promise.resolve(result).then(
            () => ({}),
            (error) => ({ error }),
          ),
        );
        return result;
      });
      try {
        instruction.schedule(pending);
        expect(instruction.timers.has(pending.id)).toBe(true);
        if (failure === 'missing execution') {
          await execution.destroy();
          expect(await model.findByPk(execution.id)).toBeNull();
        } else {
          model.addHook('beforeFind', 'fail-due-execution-read', (options) => {
            faultInjected = true;
            model.removeHook('beforeFind', 'fail-due-execution-read');
            options.where = { missingDelayExecutionColumn: true };
          });
        }
        await waitForFastAssertion(() => expect(outcomes).toHaveLength(1));
        const outcome = await outcomes[0];
        if (failure === 'SQL failure') {
          expect(faultInjected).toBe(true);
          const sqlError = outcome.error ?? errors.mock.calls[0]?.[1];
          expect(sqlError).toMatchObject({ name: 'SequelizeDatabaseError' });
          expect((sqlError as Error).message).toMatch(/no such column/);
        }
        expect(outcome.error).toBeUndefined();
        expect(instruction.timers.has(pending.id)).toBe(false);
        expect(await app.db.getCollection('delayFailureResults').model.count()).toBe(0);
        if (failure === 'SQL failure') {
          expect(errors).toHaveBeenCalledWith(
            'failed to trigger delayed workflow execution',
            expect.objectContaining({ name: 'SequelizeDatabaseError' }),
          );
          expect((await execution.reload()).status).toBe(EXECUTION_STATUS.STARTED);
          expect((await pending.reload()).status).toBe(JOB_STATUS.PENDING);
          // A fresh explicit schedule can recover after the one-shot SQL fault is removed.
          instruction.schedule(pending);
          await waitForFastAssertion(() => expect(outcomes).toHaveLength(2));
          expect((await outcomes[1]).error).toBeUndefined();
          await waitForWorkflowIdle(app);
          expect((await execution.reload()).status).toBe(EXECUTION_STATUS.RESOLVED);
          const rows = await app.db.getCollection('delayFailureResults').model.findAll();
          expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Recovered B delay']]);
        }
      } finally {
        model.removeHook('beforeFind', 'fail-due-execution-read');
        instruction.unload();
        await Promise.all(outcomes);
        await waitForWorkflowIdle(app);
        observe.mockRestore();
        errors.mockRestore();
      }
    },
  );

  it('cancels every pending timer after repeated real discovery and permits a fresh explicit load', async () => {
    const { execution } = await createPendingTenantDelay();
    const original = instruction.trigger.bind(instruction);
    const outcomes: Promise<unknown>[] = [];
    const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
      const result = original(job);
      outcomes.push(Promise.resolve(result).catch((error) => error));
      return result;
    });
    try {
      await instruction.load();
      await instruction.load();
      instruction.unload();
      // Real timers: this checkpoint expires after the original job's actual deadline.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      expect(await app.db.getCollection('delayFailureResults').model.count()).toBe(0);
      expect((await execution.reload()).status).toBe(EXECUTION_STATUS.STARTED);

      await instruction.load();
      await waitForFastAssertion(async () => {
        expect((await execution.reload()).status).toBe(EXECUTION_STATUS.RESOLVED);
      });
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      const rows = await app.db.getCollection('delayFailureResults').model.findAll();
      expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Recovered B delay']]);
    } finally {
      instruction.unload();
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      observe.mockRestore();
    }
  });

  it.each(['discovery', 'due execution'])(
    'discards a real %s read completed before unload but delivered afterward',
    async (stage) => {
      const { execution } = await createPendingTenantDelay();
      const model = app.db.getCollection(stage === 'discovery' ? 'jobs' : 'executions').model;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let read = false;
      model.addHook('afterFind', 'pause-delay-discovery', async () => {
        model.removeHook('afterFind', 'pause-delay-discovery');
        read = true;
        await barrier;
      });
      const original = instruction.trigger.bind(instruction);
      const outcomes: Promise<unknown>[] = [];
      const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
        const result = original(job);
        outcomes.push(Promise.resolve(result).catch((error) => error));
        return result;
      });
      const loading = instruction.load();
      try {
        await waitForFastAssertion(() => expect(read).toBe(true));
        instruction.unload();
        release();
        await loading;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await Promise.all(outcomes);
        await waitForWorkflowIdle(app);
        expect(await app.db.getCollection('delayFailureResults').model.count()).toBe(0);
        expect((await execution.reload()).status).toBe(EXECUTION_STATUS.STARTED);

        await instruction.load();
        await waitForFastAssertion(async () => {
          expect((await execution.reload()).status).toBe(EXECUTION_STATUS.RESOLVED);
        });
        await Promise.all(outcomes);
        await waitForWorkflowIdle(app);
        const rows = await app.db.getCollection('delayFailureResults').model.findAll();
        expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Recovered B delay']]);
      } finally {
        release();
        model.removeHook('afterFind', 'pause-delay-discovery');
        await loading.catch(() => undefined);
        instruction.unload();
        await Promise.all(outcomes);
        await waitForWorkflowIdle(app);
        observe.mockRestore();
      }
    },
  );

  it('keeps the newer persisted deadline when an older real discovery finishes last', async () => {
    const { execution, pending, delay } = await createPendingTenantDelay(10000);
    const model = app.db.getCollection('jobs').model;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let read = false;
    model.addHook('afterFind', 'pause-older-delay-discovery', async () => {
      model.removeHook('afterFind', 'pause-older-delay-discovery');
      read = true;
      await barrier;
    });
    const original = instruction.trigger.bind(instruction);
    const outcomes: Promise<unknown>[] = [];
    const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
      const result = original(job);
      outcomes.push(Promise.resolve(result).catch((error) => error));
      return result;
    });
    const older = instruction.load();
    try {
      await waitForFastAssertion(() => expect(read).toBe(true));
      await delay.update({ config: { duration: 3000, endStatus: JOB_STATUS.RESOLVED } });
      await instruction.load();
      expect(instruction.timers.has(pending.id)).toBe(true);
      release();
      await older;
      const checkpointDelay = Math.max(0, Date.parse(pending.createdAt) + 3000 - Date.now()) + 100;
      await new Promise((resolve) => setTimeout(resolve, checkpointDelay));
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      const rows = await app.db.getCollection('delayFailureResults').model.findAll();
      expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Recovered B delay']]);
      expect((await execution.reload()).status).toBe(EXECUTION_STATUS.RESOLVED);
    } finally {
      release();
      model.removeHook('afterFind', 'pause-older-delay-discovery');
      await older.catch(() => undefined);
      instruction.unload();
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      observe.mockRestore();
    }
  });

  it('keeps a thirty-day tenant delay pending instead of overflowing into immediate execution', async () => {
    const { execution, pending } = await createPendingTenantDelay(30 * 86400000);
    const original = instruction.trigger.bind(instruction);
    const outcomes: Promise<unknown>[] = [];
    const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
      const result = original(job);
      outcomes.push(Promise.resolve(result).catch((error) => error));
      return result;
    });
    try {
      instruction.schedule(pending);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      expect(await app.db.getCollection('delayFailureResults').model.count()).toBe(0);
      expect((await execution.reload()).status).toBe(EXECUTION_STATUS.STARTED);

      // Move only this fixture's persisted timestamp beyond the real deadline, then use the original loader.
      const jobs = app.db.getCollection('jobs').model;
      const queryGenerator = app.db.sequelize.getQueryInterface().queryGenerator;
      const table = queryGenerator.quoteTable(jobs.getTableName());
      const createdAt = queryGenerator.quoteIdentifier(jobs.rawAttributes.createdAt.field);
      const id = queryGenerator.quoteIdentifier(jobs.primaryKeyField);
      await app.db.sequelize.query(
        `UPDATE ${table} SET ${createdAt} = datetime('now', '-31 days') WHERE ${id} = $jobId`,
        { bind: { jobId: pending.id } },
      );
      await instruction.load();
      await waitForFastAssertion(async () => {
        expect((await execution.reload()).status).toBe(EXECUTION_STATUS.RESOLVED);
      });
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      const rows = await app.db.getCollection('delayFailureResults').model.findAll();
      expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Recovered B delay']]);
    } finally {
      instruction.unload();
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      observe.mockRestore();
    }
  });

  it('does not replay a completed delay from an older discovery while its execution waits downstream', async () => {
    const { execution, pending, delay } = await createPendingTenantDelay(0);
    const consumer = await delay.getDownstream();
    const nextDelay = await execution.getWorkflow().then((workflow) =>
      workflow.createNode({
        type: 'delay',
        upstreamId: consumer.id,
        config: { duration: 30 * 86400000, endStatus: JOB_STATUS.RESOLVED },
      }),
    );
    await consumer.setDownstream(nextDelay);
    const model = app.db.getCollection('jobs').model;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let read = false;
    model.addHook('afterFind', 'pause-completed-delay-discovery', async (_jobs, options) => {
      if (!options.include?.length) return;
      model.removeHook('afterFind', 'pause-completed-delay-discovery');
      read = true;
      await barrier;
    });
    const original = instruction.trigger.bind(instruction);
    const outcomes: Promise<unknown>[] = [];
    const observe = vi.spyOn(instruction, 'trigger').mockImplementation((job) => {
      const result = original(job);
      outcomes.push(Promise.resolve(result).catch((error) => error));
      return result;
    });
    const loading = instruction.load();
    try {
      await waitForFastAssertion(() => expect(read).toBe(true));
      instruction.schedule(pending);
      await waitForFastAssertion(async () => {
        expect((await pending.reload()).status).toBe(JOB_STATUS.RESOLVED);
        expect(await app.db.getCollection('delayFailureResults').model.count()).toBe(1);
      });
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      expect((await execution.reload()).status).toBe(EXECUTION_STATUS.STARTED);
      expect(await app.db.getCollection('delayFailureResults').model.count()).toBe(1);
      release();
      await loading;
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      const rows = await app.db.getCollection('delayFailureResults').model.findAll();
      expect(rows.map((row) => [row.get('tenantId'), row.get('label')])).toEqual([['B', 'Recovered B delay']]);
      const waiting = await model.findAll({ where: { executionId: execution.id, status: JOB_STATUS.PENDING } });
      expect(waiting.map((job) => job.nodeId)).toEqual([nextDelay.id]);
    } finally {
      release();
      model.removeHook('afterFind', 'pause-completed-delay-discovery');
      await loading.catch(() => undefined);
      instruction.unload();
      await Promise.all(outcomes);
      await waitForWorkflowIdle(app);
      observe.mockRestore();
    }
  });
});
