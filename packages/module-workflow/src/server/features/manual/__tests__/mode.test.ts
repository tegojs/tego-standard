import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/plugin-workflow';
import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { waitForAssertion } from '../../../__tests__/utils';

// NOTE: skipped because time is not stable on github ci, but should work in local
describe('workflow > instructions > manual', () => {
  let app: MockServer;
  let agent;
  let userAgents;
  let db: Database;
  let PostRepo;
  let CommentRepo;
  let WorkflowModel;
  let workflow;
  let UserModel;
  let users;
  let UserJobModel;

  beforeEach(async () => {
    app = await getApp({
      plugins: ['users', 'auth', 'workflow-manual'],
    });
    // await app.pm.get('auth').install();
    agent = app.agent();
    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    PostRepo = db.getCollection('posts').repository;
    CommentRepo = db.getCollection('comments').repository;
    UserModel = db.getCollection('users').model;
    UserJobModel = db.getModel('users_jobs');

    users = await UserModel.bulkCreate([
      { id: 2, nickname: 'a' },
      { id: 3, nickname: 'b' },
    ]);

    userAgents = users.map((user) => app.agent().login(user));

    workflow = await WorkflowModel.create({
      enabled: true,
      type: 'collection',
      config: {
        mode: 1,
        collection: 'posts',
      },
    });
  });

  afterEach(() => app.destroy());

  async function waitForUserJobs(expected = 2) {
    let userJobs;

    await waitForAssertion(async () => {
      userJobs = await UserJobModel.findAll({
        order: [['userId', 'ASC']],
      });
      expect(userJobs.length).toBe(expected);
    });

    return userJobs;
  }

  async function waitForExecutionJob(
    executionStatus: number,
    jobStatus: number,
    result: any,
    options: { userJobs?: number } = {},
  ) {
    let execution;
    let job;
    let userJobs;

    await waitForAssertion(async () => {
      [execution] = await workflow.getExecutions();
      expect(execution.status).toBe(executionStatus);
      [job] = await execution.getJobs();
      expect(job.status).toBe(jobStatus);
      expect(job.result).toBe(result);

      if (options.userJobs) {
        userJobs = await UserJobModel.findAll({
          order: [['userId', 'ASC']],
        });
        expect(userJobs.length).toBe(options.userJobs);
      }
    });

    return { execution, job, userJobs };
  }

  describe('mode: 0 (single record)', () => {
    it('the only user assigned could submit', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id],
          forms: {
            f1: {
              actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      let pending;
      let j1;
      let usersJobs;

      await waitForAssertion(async () => {
        [pending] = await workflow.getExecutions();
        expect(pending.status).toBe(EXECUTION_STATUS.STARTED);
        [j1] = await pending.getJobs();
        expect(j1.status).toBe(JOB_STATUS.PENDING);

        usersJobs = await UserJobModel.findAll();
        expect(usersJobs.length).toBe(1);
        expect(usersJobs[0].status).toBe(JOB_STATUS.PENDING);
        expect(usersJobs[0].userId).toBe(users[0].id);
        expect(usersJobs[0].jobId).toBe(j1.id);
      });

      const res1 = await agent.resource('users_jobs').submit({
        filterByTk: usersJobs[0].id,
        values: { result: { f1: {}, _: 'resolve' } },
      });
      expect(res1.status).toBe(401);

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: usersJobs[0].id,
        values: {
          result: { f1: {}, _: 'resolve' },
        },
      });
      expect(res2.status).toBe(403);

      const res3 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: usersJobs[0].id,
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res3.status).toBe(202);

      await waitForAssertion(async () => {
        const [j2] = await pending.getJobs();
        expect(j2.status).toBe(JOB_STATUS.RESOLVED);
        expect(j2.result).toEqual({ f1: { a: 1 }, _: 'resolve' });

        const usersJobsAfter = await UserJobModel.findAll();
        expect(usersJobsAfter.length).toBe(1);
        expect(usersJobsAfter[0].status).toBe(JOB_STATUS.RESOLVED);
        expect(usersJobsAfter[0].result).toEqual({ f1: { a: 1 }, _: 'resolve' });
      });

      const res4 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: usersJobs[0].id,
        values: {
          result: { f1: { a: 2 }, _: 'resolve' },
        },
      });
      expect(res4.status).toBe(400);
    });

    it('any user assigned could submit', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          forms: {
            f1: {
              actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      let pending;
      let j1;
      await waitForAssertion(async () => {
        [pending] = await workflow.getExecutions();
        expect(pending.status).toBe(EXECUTION_STATUS.STARTED);
        [j1] = await pending.getJobs();
        expect(j1.status).toBe(JOB_STATUS.PENDING);
      });

      const usersJobs = await j1.getUsersJobs();

      const res1 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: usersJobs.find((item) => item.userId === users[1].id).id,
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForAssertion(async () => {
        const [j2] = await pending.getJobs();
        expect(j2.status).toBe(JOB_STATUS.RESOLVED);
        expect(j2.result).toEqual({ f1: { a: 1 }, _: 'resolve' });
      });

      const res2 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: usersJobs.find((item) => item.userId === users[0].id).id,
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res2.status).toBe(400);
    });

    it('also could submit to users_jobs api', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id],
          forms: {
            f1: {
              actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const UserJobModel = db.getModel('users_jobs');
      let usersJobs;
      await waitForAssertion(async () => {
        usersJobs = await UserJobModel.findAll();
        expect(usersJobs.length).toBe(1);
        expect(usersJobs[0].get('status')).toBe(JOB_STATUS.PENDING);
        expect(usersJobs[0].get('userId')).toBe(users[0].id);
      });

      const res = await userAgents[0].resource('users_jobs').submit({
        filterByTk: usersJobs[0].get('id'),
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res.status).toBe(202);

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [job] = await execution.getJobs();
        expect(job.status).toBe(JOB_STATUS.RESOLVED);
        expect(job.result).toEqual({ f1: { a: 1 }, _: 'resolve' });
      });
    });
  });

  describe('mode: 1 (multiple record, all)', () => {
    it('all resolved', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          mode: 1,
          forms: {
            f1: {
              actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const pendingJobs = await waitForUserJobs();

      const res1 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: pendingJobs[0].get('id'),
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.STARTED, JOB_STATUS.PENDING, 0.5, { userJobs: 2 });

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: pendingJobs[1].get('id'),
        values: {
          result: { f1: { a: 2 }, _: 'resolve' },
        },
      });
      expect(res2.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.RESOLVED, JOB_STATUS.RESOLVED, 1);
    });

    it('first rejected', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          mode: 1,
          forms: {
            f1: {
              actions: [{ status: JOB_STATUS.REJECTED, key: 'reject' }],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const pendingJobs = await waitForUserJobs();

      const res1 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: pendingJobs[0].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.REJECTED, JOB_STATUS.REJECTED, 0.5, { userJobs: 2 });

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: pendingJobs[1].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res2.status).toBe(400);
    });

    it('last rejected', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          mode: 1,
          forms: {
            f1: {
              actions: [
                { status: JOB_STATUS.RESOLVED, key: 'resolve' },
                { status: JOB_STATUS.REJECTED, key: 'reject' },
              ],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const pendingJobs = await waitForUserJobs();

      const res1 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: pendingJobs[0].get('id'),
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.STARTED, JOB_STATUS.PENDING, 0.5, { userJobs: 2 });

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: pendingJobs[1].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res2.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.REJECTED, JOB_STATUS.REJECTED, 1);
    });
  });

  describe('mode: -1 (multiple record, any)', () => {
    it('first resolved', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          mode: -1,
          forms: {
            f1: {
              actions: [
                { status: JOB_STATUS.RESOLVED, key: 'resolve' },
                { status: JOB_STATUS.REJECTED, key: 'reject' },
              ],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const pendingJobs = await waitForUserJobs();

      const res1 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: pendingJobs[0].get('id'),
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.RESOLVED, JOB_STATUS.RESOLVED, 0.5);

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: pendingJobs[1].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res2.status).toBe(400);
    });

    it('any resolved', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          mode: -1,
          forms: {
            f1: {
              actions: [
                { status: JOB_STATUS.RESOLVED, key: 'resolve' },
                { status: JOB_STATUS.REJECTED, key: 'reject' },
              ],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const pendingJobs = await waitForUserJobs();

      const res1 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: pendingJobs[0].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.STARTED, JOB_STATUS.PENDING, 0.5);

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: pendingJobs[1].get('id'),
        values: {
          result: { f1: { a: 1 }, _: 'resolve' },
        },
      });
      expect(res2.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.RESOLVED, JOB_STATUS.RESOLVED, 1);
    });

    it('all rejected', async () => {
      const n1 = await workflow.createNode({
        type: 'manual',
        config: {
          assignees: [users[0].id, users[1].id],
          mode: -1,
          forms: {
            f1: {
              actions: [{ status: JOB_STATUS.REJECTED, key: 'reject' }],
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const pendingJobs = await waitForUserJobs();

      const res1 = await userAgents[0].resource('users_jobs').submit({
        filterByTk: pendingJobs[0].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res1.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.STARTED, JOB_STATUS.PENDING, 0.5);

      const res2 = await userAgents[1].resource('users_jobs').submit({
        filterByTk: pendingJobs[1].get('id'),
        values: {
          result: { f1: { a: 0 }, _: 'reject' },
        },
      });
      expect(res2.status).toBe(202);

      await waitForExecutionJob(EXECUTION_STATUS.REJECTED, JOB_STATUS.REJECTED, 1);
    });
  });
});
