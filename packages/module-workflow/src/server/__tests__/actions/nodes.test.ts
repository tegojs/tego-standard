import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { update as updateNodeAction } from '../../actions/nodes';
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

describe('workflow > actions > nodes update guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should throw 404 when filter-based node lookup finds no node', async () => {
    const repository = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
    };
    const ctx: any = {
      db: {
        getRepository: vi.fn(() => repository),
        sequelize: {
          transaction: async (callback) => callback('tx-1'),
        },
      },
      action: {
        resourceName: 'flow_nodes',
        actionName: 'update',
        params: {
          filter: { id: 404 },
          values: { title: 'missing' },
        },
      },
      throw: vi.fn((status: number, message: string) => {
        const error = new Error(message) as Error & { status?: number };
        error.status = status;
        throw error;
      }),
    };

    await expect(updateNodeAction(ctx, vi.fn())).rejects.toMatchObject({
      status: 404,
      message: 'Node not found',
    });
  });

  it('should reuse filter and context when loading workflow state for filter-based updates', async () => {
    const nodeWithWorkflow = {
      workflow: {
        executed: false,
      },
    };
    const repository = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(nodeWithWorkflow),
      update: vi.fn().mockResolvedValue([nodeWithWorkflow]),
    };
    const ctx: any = {
      db: {
        getRepository: vi.fn(() => repository),
        sequelize: {
          transaction: async (callback) => callback('tx-1'),
        },
      },
      action: {
        resourceName: 'flow_nodes',
        actionName: 'update',
        params: {
          filter: { workflowId: 1 },
          values: { title: 'updated' },
        },
      },
      throw: vi.fn(),
    };
    const next = vi.fn();

    await updateNodeAction(ctx, next);

    expect(repository.findOne).toHaveBeenCalledWith({
      filter: { workflowId: 1 },
      appends: ['workflow.executed'],
      context: ctx,
      transaction: 'tx-1',
    });
    expect(next).toHaveBeenCalled();
  });

  it('should reject filter-based updates that span multiple workflows', async () => {
    const repository = {
      find: vi
        .fn()
        .mockResolvedValue([
          { get: (key: string) => (key === 'workflowId' ? 1 : 'manual') },
          { get: (key: string) => (key === 'workflowId' ? 2 : 'manual') },
        ]),
      findOne: vi.fn(),
      update: vi.fn(),
    };
    const ctx: any = {
      db: {
        getRepository: vi.fn(() => repository),
        sequelize: {
          transaction: async (callback) => callback('tx-1'),
        },
      },
      action: {
        resourceName: 'flow_nodes',
        actionName: 'update',
        params: {
          filter: { type: 'manual' },
          values: { title: 'updated' },
        },
      },
      throw: vi.fn((status: number, message: string) => {
        const error = new Error(message) as Error & { status?: number };
        error.status = status;
        throw error;
      }),
    };

    await expect(updateNodeAction(ctx, vi.fn())).rejects.toMatchObject({
      status: 400,
      message: 'flow node update filter must not span multiple workflows',
    });
    expect(repository.update).not.toHaveBeenCalled();
  });
});
