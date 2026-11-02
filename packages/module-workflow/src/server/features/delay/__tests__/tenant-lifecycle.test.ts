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

  async function createPendingTenantDelay() {
    const workflow = await app.db.getRepository('workflows').create({
      values: { type: 'collection', enabled: true, config: { collection: 'delayFailureSources', mode: 1 } },
    });
    const delay = await workflow.createNode({
      type: 'delay',
      config: { duration: 1000, endStatus: JOB_STATUS.RESOLVED },
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
    return { execution, pending };
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
});
