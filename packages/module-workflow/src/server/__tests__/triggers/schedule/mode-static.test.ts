import { scryptSync } from 'node:crypto';
import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { waitForAssertion, waitForWorkflowIdle } from '../../utils';

const SHORT_REPEAT_MS = 100;

function getFutureSecond(minDelay = 200) {
  return new Date(Math.ceil((Date.now() + minDelay) / 1000) * 1000);
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
      const start = getFutureSecond();

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

    it('repeat by interval', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: new Date(Date.now() - 1000).toISOString(),
          repeat: SHORT_REPEAT_MS,
          limit: 2,
        },
      });

      const executions = await waitForExecutions(workflow, 2);
    });

    it('repeat by interval and limit 1', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: new Date(Date.now() - 1000).toISOString(),
          repeat: SHORT_REPEAT_MS,
          limit: 1,
        },
      });

      const executions = await waitForExecutions(workflow, 1);
    });

    it('start before now and repeat by interval after created and limit 1', async () => {
      const repeat = 2000;
      const start = new Date();
      start.setMilliseconds(0);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 0,
          startsOn: start.toISOString(),
          repeat,
          limit: 1,
        },
      });

      const executions = await waitForExecutions(workflow, 1);
      expect(new Date(executions[0].context.date).getTime()).toBe(start.getTime() + repeat);
    });

    it('repeat on cron certain second', async () => {
      const now = getFutureSecond(800);
      const startsOn = new Date(now.getTime() - 2000).toISOString();

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
          repeat: SHORT_REPEAT_MS,
          limit: 1,
        },
      });

      await waitForAssertion(
        async () => {
          const e2s = await workflow.getExecutions();
          expect(e2s.length).toBe(1);
        },
        8000,
        200,
      );
    });
  });

  describe('status', () => {
    it('should not trigger after turned off', async () => {
      const future = getFutureSecond();

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
      const now = getFutureSecond(800);
      const startsOn = new Date(now.getTime() - 2000).toISOString();

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
      const d2 = new Date(e2.context.date);
      d2.setMilliseconds(0);
      expect(d2.getTime()).toBe(now.getTime());
    });

    it('missed non-repeated scheduled time should not be triggered', async () => {
      const start = getFutureSecond();

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
      const start = getFutureSecond(700);

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
