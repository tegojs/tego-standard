import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { waitForFastAssertion as waitForAssertion, waitForWorkflowIdle } from '../utils';

describe('workflow > actions > workflows', () => {
  let app: MockServer;
  let agent;
  let db: Database;
  let PostRepo;
  let WorkflowModel;

  beforeAll(async () => {
    app = await getApp();
    agent = app.agent();
    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    PostRepo = db.getCollection('posts').repository;
  });

  beforeEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
    await PostRepo.destroy({ filter: {} });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(() => app.destroy());

  describe('destroy', () => {
    it('node in executed workflow could not be destroyed', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const n1 = await workflow.createNode({
        type: 'echo',
      });

      await PostRepo.create({});

      await waitForAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.length).toBe(1);
      });

      const { status } = await agent.resource('flow_nodes').destroy({
        filterByTk: n1.id,
      });

      expect(status).toBe(400);
    });

    it('cascading destroy all nodes in sub-branches', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const n1 = await workflow.createNode({
        type: 'echo',
      });

      const n2 = await workflow.createNode({
        type: 'echo',
        branchIndex: 0,
        upstreamId: n1.id,
      });

      const n3 = await workflow.createNode({
        type: 'echo',
        branchIndex: 0,
        upstreamId: n2.id,
      });

      await agent.resource('flow_nodes').destroy({
        filterByTk: n1.id,
      });

      const nodes = await workflow.getNodes();
      expect(nodes.length).toBe(0);
    });
  });
});
