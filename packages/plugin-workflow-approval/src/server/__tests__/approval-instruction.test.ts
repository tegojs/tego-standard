import { Model } from '@tego/server';

import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_ACTION_STATUS } from '../constants/status';
import ApprovalInstruction from '../instructions/Approval';

describe('ApprovalInstruction', () => {
  it('refreshes snapshots from plain model data when default serialization is broken', async () => {
    const persistedData = { id: 42, owner: { password: 'secret' }, title: 'visible' };
    class BrokenAssociationRecord extends Model {
      static associations = {};

      get(options?: { plain?: boolean }) {
        if (options?.plain) {
          return persistedData;
        }
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      }
    }
    const data = Object.create(BrokenAssociationRecord.prototype);
    data.dataValues = persistedData;
    const update = vi.fn();
    const approval = {
      collectionName: 'orders',
      get: vi.fn((key: string) => ({ workflowId: 1, dataKey: 42 })[key]),
      getWorkflow: vi.fn().mockResolvedValue({ config: { appends: [], summary: [] } }),
    };
    const recordRepository = {
      find: vi.fn().mockResolvedValue([{ status: APPROVAL_ACTION_STATUS.PENDING, approval }]),
      update,
    };
    const collection = {
      repository: { findOne: vi.fn().mockResolvedValue(data) },
      getField: vi.fn(() => undefined),
      model: { associations: {} },
    };
    const app = {
      dataSourceManager: {
        dataSources: {
          get: vi.fn(() => ({ collectionManager: { getCollection: vi.fn(() => collection) } })),
        },
      },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'approvalRecords') return recordRepository;
          if (name === 'users') return { find: vi.fn() };
          throw new Error(`Unexpected repository ${name}`);
        }),
      },
    };
    const workflow = { app, useDataSourceTransaction: vi.fn(() => undefined) };
    const instruction = new ApprovalInstruction(workflow as any);
    const node = {
      id: 1,
      config: { assignees: [7], branchMode: false, negotiation: 0, order: false },
    };
    const job = {
      nodeId: 1,
      latestUserJob: { userId: 7 },
      set: vi.fn(),
    };
    const processor = {
      getParsedValue: vi.fn((value) => value),
      logger: { debug: vi.fn() },
      options: { plugin: { app } },
      transaction: undefined,
    };

    await instruction.resume(node as any, job as any, processor as any);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        values: { snapshot: { id: 42, owner: {}, title: 'visible' } },
      }),
    );
  });
});
