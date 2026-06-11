import { scryptSync } from 'node:crypto';
import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { waitForAssertion, waitForWorkflowIdle } from '../../utils';

async function sleepToNextSecond() {
  const now = new Date();
  const SECOND_BUFFER_MS = 200;
  // NOTE: align to the next second with a small buffer for scheduler stability.
  await sleep(1000 + SECOND_BUFFER_MS - now.getMilliseconds());
}

async function sleepUntil(time: Date | number, buffer = 200) {
  await sleep(Math.max(0, (time instanceof Date ? time.getTime() : time) + buffer - Date.now()));
}

function consumeTimeUntil(time: Date | number) {
  const endAt = time instanceof Date ? time.getTime() : time;
  let i = 0;

  while (Date.now() < endAt) {
    scryptSync(`${i++}`, 'salt', 64);
  }
}

async function waitForExecutions(workflow, expected: number, options?: any, timeout = 10000) {
  let executions;

  await waitForAssertion(
    async () => {
      executions = await workflow.getExecutions(options);
      expect(executions.length).toBe(expected);
    },
    timeout,
    50,
  );

  return executions;
}

describe('workflow > triggers > schedule > static mode', () => {
  let app: MockServer;
  let db: Database;
  let PostRepo;
  let CategoryRepo;
  let WorkflowModel;
  let WorkflowRepo;

  beforeAll(async () => {
    app = await getApp();

    db = app.db;
    const workflow = db.getCollection('workflows');
    WorkflowModel = workflow.model;
    WorkflowRepo = workflow.repository;
    PostRepo = db.getCollection('posts').repository;
    CategoryRepo = db.getCollection('categories').repository;
  });

  beforeEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(() => app.destroy());

  describe('configuration', () => {
    it('neither startsOn nor repeat configurated', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
        },
      });

      await sleep(200);

      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(0);
    });

    it('start on certain time and no repeat', async () => {
      await sleepToNextSecond();

      const start = new Date();
      start.setMilliseconds(0);
      start.setSeconds(start.getSeconds() + 2);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: start.toISOString(),
        },
      });

      const executions = await waitForExecutions(workflow, 1);
    });

    it('on every second', async () => {
      await sleepToNextSecond();

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: new Date(Date.now() - 1000).toISOString(),
          repeat: '* * * * * *',
        },
      });

      const executions = await waitForExecutions(workflow, 2);
    });

    it('on every second and limit 1', async () => {
      await sleepToNextSecond();

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: new Date(Date.now() - 1000).toISOString(),
          repeat: '* * * * * *',
          limit: 1,
        },
      });

      const executions = await waitForExecutions(workflow, 1);
    });

    it('start before now and repeat every second after created and limit 1', async () => {
      await sleepToNextSecond();
      const start = new Date();
      start.setMilliseconds(0);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: start.toISOString(),
          repeat: 1000,
          limit: 1,
        },
      });

      const executions = await waitForExecutions(workflow, 1);
      expect(new Date(executions[0].context.date).getTime()).toBe(start.getTime() + 1000);
    });

    it('repeat on cron certain second', async () => {
      await sleepToNextSecond();

      const now = new Date();
      now.setMilliseconds(0);
      const startsOn = now.toISOString();
      now.setSeconds(now.getSeconds() + 1);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn,
          repeat: `${now.getSeconds()} * * * * *`,
        },
      });

      const executions = await waitForExecutions(workflow, 1);
      const date = new Date(executions[0].context.date);
      expect(date.getTime()).toBe(now.getTime());
    });

    it('no repeat triggered then update to repeat', async () => {
      const start = new Date(Date.now() - 1000);
      start.setMilliseconds(0);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: start.toISOString(),
        },
      });

      await sleep(200);

      const e1s = await workflow.getExecutions();
      expect(e1s.length).toBe(0);

      await workflow.update({
        config: {
          ...workflow.config,
          repeat: 1000,
        },
      });

      await waitForAssertion(
        async () => {
          const e2s = await workflow.getExecutions();
          expect(e2s.length).toBe(2);
        },
        8000,
        200,
      );
    });
  });

  describe('status', () => {
    it('should not trigger after turned off', async () => {
      const future = new Date();
      future.setSeconds(future.getSeconds() + 1);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: future.toISOString(),
          repeat: 1000,
        },
      });

      await workflow.update({ enabled: false });

      await sleepUntil(future);

      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(0);
    });
  });

  describe('dispatch', () => {
    it('multiple workflows trigger at same time', async () => {
      const now = new Date();
      const startsOn = now.toISOString();
      now.setSeconds(now.getSeconds() + 1);
      now.setMilliseconds(0);

      let w1, w2;
      await db.sequelize.transaction(async (transaction) => {
        w1 = await WorkflowRepo.create({
          values: {
            enabled: true,
            type: 'schedule',
            config: {
              mode: 0,
              startsOn,
              repeat: `${now.getSeconds()} * * * * *`,
            },
          },
          transaction,
        });

        w2 = await WorkflowRepo.create({
          values: {
            enabled: true,
            type: 'schedule',
            config: {
              mode: 0,
              startsOn,
              repeat: `${now.getSeconds()} * * * * *`,
            },
          },
          transaction,
        });
      });

      await waitForAssertion(async () => {
        expect(await w1.countExecutions()).toBe(1);
        expect(await w2.countExecutions()).toBe(1);
      });
      await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });

      const [e1] = await w1.getExecutions();
      expect(e1).toBeDefined();
      const d1 = new Date(e1.context.date);
      d1.setMilliseconds(0);
      expect(d1.getTime()).toBe(now.getTime());

      const [e2] = await w2.getExecutions();
      expect(e2).toBeDefined();
      const d2 = new Date(e1.context.date);
      d2.setMilliseconds(0);
      expect(d2.getTime()).toBe(now.getTime());
    });

    it('missed non-repeated scheduled time should not be triggered', async () => {
      await sleepToNextSecond();

      const start = new Date();
      start.setMilliseconds(0);
      start.setSeconds(start.getSeconds() + 1);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: start.toISOString(),
        },
      });

      await app.stop();

      await sleepUntil(start, 1000);

      await app.start();

      await sleep(200);

      const c1 = await workflow.countExecutions();
      expect(c1).toBe(0);
    });

    it('scheduled time on CPU heavy load should be triggered', async () => {
      await sleepToNextSecond();

      const start = new Date();
      start.setMilliseconds(0);
      start.setSeconds(start.getSeconds() + 1);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: start.toISOString(),
        },
      });

      await sleep(500);

      const c1 = await workflow.countExecutions();
      expect(c1).toBe(0);

      consumeTimeUntil(start.getTime() + 200);

      await waitForAssertion(async () => {
        const c2 = await workflow.countExecutions();
        expect(c2).toBe(1);
      });
    });
  });
});
