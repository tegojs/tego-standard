import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/plugin-workflow';
import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import Database, { Application } from '@tego/server';

import { waitForWorkflowJob } from '../../../__tests__/utils';

describe('workflow > instructions > delay', () => {
  let app: Application;
  let db: Database;
  let PostRepo;
  let WorkflowModel;
  let workflow;
  let plugin;

  beforeEach(async () => {
    app = await getApp({
      plugins: ['workflow-delay'],
    });
    plugin = app.pm.get('workflow');

    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    PostRepo = db.getCollection('posts').repository;

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

  describe('runtime', () => {
    it('delay to resolved', async () => {
      const n1 = await workflow.createNode({
        type: 'delay',
        config: {
          duration: 2000,
          endStatus: JOB_STATUS.RESOLVED,
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.STARTED);
        expect(job.status).toBe(JOB_STATUS.PENDING);
      });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
        expect(job.status).toBe(JOB_STATUS.RESOLVED);
      });
    });

    it('delay to reject', async () => {
      const n1 = await workflow.createNode({
        type: 'delay',
        config: {
          duration: 2000,
          endStatus: JOB_STATUS.FAILED,
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.STARTED);
        expect(job.status).toBe(JOB_STATUS.PENDING);
      });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.FAILED);
        expect(job.status).toBe(JOB_STATUS.FAILED);
      });
    });

    it('delay to resolve and downstream node error', async () => {
      const n1 = await workflow.createNode({
        type: 'delay',
        config: {
          duration: 2000,
          endStatus: JOB_STATUS.RESOLVED,
        },
      });
      const n2 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'notExistsTable',
          params: {
            values: {},
          },
        },
        upstreamId: n1.id,
      });
      await n1.setDownstream(n2);

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.STARTED);
        expect(job.status).toBe(JOB_STATUS.PENDING);
      });

      await waitForWorkflowJob(
        workflow,
        (execution, [delayJob, errorJob]) => {
          expect(execution.status).toEqual(EXECUTION_STATUS.ERROR);
          expect(delayJob.status).toBe(JOB_STATUS.RESOLVED);
          expect(errorJob.status).toBe(JOB_STATUS.ERROR);
        },
        { jobOptions: { order: [['id', 'ASC']] } },
      );
    });
  });

  describe('app lifecycle', () => {
    beforeEach(async () => {
      await workflow.createNode({
        type: 'delay',
        config: {
          duration: 2000,
          endStatus: JOB_STATUS.RESOLVED,
        },
      });
    });

    it('restart app should trigger delayed job', async () => {
      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.STARTED);
        expect(job.status).toBe(JOB_STATUS.PENDING);
      });

      await app.stop();
      await sleep(500);

      await app.start();
      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
        expect(job.status).toBe(JOB_STATUS.RESOLVED);
      });
    });

    it('restart app should trigger missed delayed job', async () => {
      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.STARTED);
        expect(job.status).toBe(JOB_STATUS.PENDING);
      });

      await app.stop();
      await sleep(2000);

      await app.start();
      await waitForWorkflowJob(workflow, (execution, [job]) => {
        expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
        expect(job.status).toBe(JOB_STATUS.RESOLVED);
      });
    });
  });
});
