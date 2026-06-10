import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { waitForAssertion } from '../../utils';

async function sleepToEvenSecond() {
  const now = new Date();
  const EVEN_SECOND_BUFFER_MS = 200;
  // NOTE: align to the next even second with a small buffer for scheduler stability.
  await sleep((2 - (now.getSeconds() % 2)) * 1000 + EVEN_SECOND_BUFFER_MS - now.getMilliseconds());
  return now;
}

async function sleepUntil(time: Date | number, buffer = 200) {
  await sleep(Math.max(0, (time instanceof Date ? time.getTime() : time) + buffer - Date.now()));
}

async function waitForExecutions(workflow, expected: number, options?: any, timeout = 30000) {
  let executions;

  await waitForAssertion(async () => {
    executions = await workflow.getExecutions(options);
    expect(executions.length).toBe(expected);
  }, timeout);

  return executions;
}

describe('workflow > triggers > schedule > date field mode', () => {
  let app: MockServer;
  let db: Database;
  let PostRepo;
  let CategoryRepo;
  let WorkflowModel;
  let WorkflowRepo;

  beforeEach(async () => {
    app = await getApp();

    db = app.db;
    const workflow = db.getCollection('workflows');
    WorkflowModel = workflow.model;
    WorkflowRepo = workflow.repository;
    PostRepo = db.getCollection('posts').repository;
    CategoryRepo = db.getCollection('categories').repository;
  });

  afterEach(() => app.destroy());

  describe('configuration', () => {
    it('starts on post.createdAt', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
        },
      });

      const now = await sleepToEvenSecond();

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 1);
      expect(executions[0].context.data.id).toBe(post.id);
      const triggerTime = new Date(post.createdAt);
      triggerTime.setMilliseconds(0);
      expect(executions[0].context.date).toBe(triggerTime.toISOString());
    });

    it('starts on post.createdAt with +offset', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
            offset: 1,
          },
        },
      });

      const createdAt = new Date(Date.now() + 2000);
      createdAt.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1', createdAt } });

      await sleep(500);
      const e1s = await workflow.getExecutions();
      expect(e1s.length).toBe(0);

      const e2s = await waitForExecutions(workflow, 1);
      expect(e2s[0].context.data.id).toBe(post.id);

      expect(e2s[0].context.date).toBe(new Date(createdAt.getTime() + 1000).toISOString());
    });

    it('starts on post.createdAt with -offset', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
            offset: -2,
          },
        },
      });

      const now = await sleepToEvenSecond();

      const post = await PostRepo.create({ values: { title: 't1' } });

      await sleep(500);
      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(0);
    });

    it('starts on post.createdAt and repeat by cron', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '*/2 * * * * *',
        },
      });

      await sleepToEvenSecond();
      const startTime = new Date();
      startTime.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 3, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime.getTime());
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(startTime.getTime());
      const d2 = Date.parse(executions[2].context.date);
      expect(d2 - 4000).toBe(startTime.getTime());
    });

    it('starts on post.createdAt and repeat by cron with endsOn at certain time', async () => {
      await sleepToEvenSecond();
      const startTime = new Date();
      startTime.setMilliseconds(0);

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '*/2 * * * * *',
          endsOn: new Date(startTime.getTime() + 3500).toISOString(),
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime.getTime());
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(startTime.getTime());
    });

    it('starts on post.createdAt and repeat by cron with endsOn by offset', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '*/2 * * * * *',
          endsOn: {
            field: 'createdAt',
            offset: 3,
          },
        },
      });

      await sleepToEvenSecond();
      const startTime = new Date();
      startTime.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime.getTime());
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(startTime.getTime());
    });

    it('starts on post.createdAt and repeat by cron and limit 1', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '*/2 * * * * *',
          limit: 1,
        },
      });

      await sleepToEvenSecond();
      const startTime = new Date();
      startTime.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 1, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime.getTime());
    });

    it('starts on post.createdAt and repeat by cron and limit 2', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '*/2 * * * * *',
          limit: 2,
        },
      });

      await sleepToEvenSecond();
      const startTime = new Date();
      startTime.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime.getTime());
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(startTime.getTime());
    });

    it('starts on post.createdAt and repeat by number', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: 2000,
          endsOn: {
            field: 'createdAt',
            offset: 3,
          },
        },
      });

      await sleepToEvenSecond();
      const startTime = new Date();
      startTime.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1' } });
      const triggerTime = new Date(post.createdAt);
      triggerTime.setMilliseconds(0);

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(triggerTime.getTime());
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(triggerTime.getTime());
    });

    it('appends', async () => {
      const category = await CategoryRepo.create({ values: { name: 'c1' } });

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
            offset: 1,
          },
          appends: ['category'],
        },
      });

      const post = await PostRepo.create({ values: { title: 't1', categoryId: category.id } });

      const executions = await waitForExecutions(workflow, 1);
      expect(executions[0].context.data.category.id).toBe(category.id);
    });

    it('on field changed', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: 1000,
          endsOn: {
            field: 'createdAt',
            offset: 3,
          },
        },
      });

      await sleepToEvenSecond();

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const e1c = await workflow.countExecutions();
        expect(e1c).toBe(2);
      });

      await post.update({ createdAt: new Date(post.createdAt.getTime() - 1000) });

      await sleepUntil(new Date(post.createdAt).getTime() + 3000, 500);

      const e2c = await workflow.countExecutions();
      expect(e2c).toBe(2);
    });
  });
});
