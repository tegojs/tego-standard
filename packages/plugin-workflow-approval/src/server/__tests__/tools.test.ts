import { describe, expect, it, vi } from 'vitest';

import { parseAssignees } from '../instructions/tools';
import {
  getSummary,
  getSummaryAssociationAppends,
  getWorkflowAppends,
  parsePerson,
  sendApprovalMessage,
  serializeError,
} from '../tools';

function createCollection(
  fields: Record<string, any>,
  targets: Record<string, any> = {},
  associations?: Record<string, any>,
) {
  return {
    getField: (name: string) => fields[name],
    db: {
      getCollection: (name: string) => targets[name],
    },
    ...(associations ? { model: { associations } } : {}),
  } as any;
}

function createUserProcessor(find) {
  return {
    transaction: 'transaction',
    getParsedValue: vi.fn((value) => value),
    options: {
      plugin: {
        app: {
          db: {
            getRepository: vi.fn(() => ({ find })),
          },
        },
      },
    },
  };
}

function createSummaryCollections() {
  const products = createCollection({ name: { type: 'string' } });
  const items = createCollection(
    {
      amount: { type: 'integer' },
      product: { type: 'belongsTo', target: 'products' },
    },
    { products },
  );
  const users = createCollection({ name: { type: 'string' } });
  const root = createCollection(
    {
      items: { type: 'hasMany', target: 'items' },
      owner: { type: 'belongsTo', target: 'users' },
      total: { type: 'integer' },
      unresolved: { type: 'hasOne', target: 'missing' },
    },
    { items, users },
  );

  return root;
}

describe('serializeError', () => {
  it('serializes a standard Error instance', () => {
    const error = new Error('known failure');
    error.name = 'KnownError';

    expect(serializeError(error)).toEqual({
      name: 'KnownError',
      message: 'known failure',
      stack: error.stack,
    });
  });

  it('uses a stable message when an object cannot be converted to a string', () => {
    const error = Object.assign(Object.create(null), { message: 42 });

    expect(serializeError(error)).toEqual({
      name: undefined,
      message: 'Unknown error',
      stack: undefined,
    });
  });

  it('safely serializes a proxy whose properties throw', () => {
    const error = new Proxy(
      {},
      {
        get() {
          throw new Error('property access failed');
        },
      },
    );

    expect(serializeError(error)).toEqual({
      name: undefined,
      message: 'Unknown error',
      stack: undefined,
    });
  });
});

describe('workflow appends', () => {
  it('collects nested summary associations and stops at non-association or unresolved fields', () => {
    const collection = createSummaryCollections();

    expect(
      getSummaryAssociationAppends(['items.product.name', 'items.amount', 'total', 'unresolved.value'], collection),
    ).toEqual(['items', 'items.product']);
  });

  it('merges explicit and summary appends without duplicates', () => {
    const collection = createSummaryCollections();

    expect(
      getWorkflowAppends(
        {
          appends: ['owner', 'items', 'owner'],
          summary: ['items.product.name', 'owner.name'],
        },
        collection,
      ),
    ).toEqual(['owner', 'items', 'items.product']);
  });

  it('drops explicit appends whose association path is no longer available', () => {
    const collection = createSummaryCollections();

    expect(
      getWorkflowAppends(
        {
          appends: ['owner.positions', 'owner', 'missing'],
          summary: [],
        },
        collection,
      ),
    ).toEqual(['owner']);
  });

  it('drops association paths missing from the current model even when metadata is stale', () => {
    const positions = createCollection({ name: { type: 'string' } });
    const users = createCollection(
      {
        positions: { type: 'belongsToMany', target: 'positions' },
      },
      { positions },
      {},
    );
    const root = createCollection(
      {
        owner: { type: 'belongsTo', target: 'users' },
      },
      { users },
      { owner: {} },
    );

    expect(
      getWorkflowAppends(
        {
          appends: ['owner.positions'],
          summary: ['owner.positions.name'],
        },
        root,
      ),
    ).toEqual(['owner']);
  });

  it('ignores malformed summary entries from persisted workflow configuration', () => {
    const collection = createSummaryCollections();

    expect(
      getWorkflowAppends(
        {
          appends: [undefined, null, 'owner'] as any,
          summary: [undefined, null, 'owner.name'] as any,
        },
        collection,
      ),
    ).toEqual(['owner']);
  });

  it('excludes authentication secrets from association summaries', () => {
    const users = createCollection({
      nickname: { type: 'string' },
      password: { type: 'password' },
      resetToken: { type: 'string' },
    });
    const collection = createCollection({ reviewers: { type: 'hasMany', target: 'users' } }, { users });

    const summary = getSummary({
      summaryConfig: ['reviewers', 'reviewers.nickname', 'reviewers.password', 'reviewers.resetToken'],
      data: {
        reviewers: [
          {
            nickname: 'Reviewer',
            password: 'password-hash',
            resetToken: 'reset-token',
          },
        ],
      },
      collection,
    } as any);

    expect(JSON.stringify(summary)).toContain('Reviewer');
    expect(JSON.stringify(summary)).not.toContain('password');
    expect(JSON.stringify(summary)).not.toContain('resetToken');
    expect(JSON.stringify(summary)).not.toContain('password-hash');
    expect(JSON.stringify(summary)).not.toContain('reset-token');
  });
});

describe('approval messages', () => {
  it('redacts authentication secrets at the outbound message boundary', () => {
    const sendMessage = vi.fn();

    sendApprovalMessage({ sendMessage }, 7, {
      title: 'Approval',
      jsonContent: [
        { key: 'nickname', value: 'Reviewer' },
        { key: 'password', value: 'password-hash' },
        { key: 'createdBy.resetToken', value: 'reset-token' },
      ],
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const payload = sendMessage.mock.calls[0][1];
    expect(payload.jsonContent).toEqual([{ key: 'nickname', value: 'Reviewer' }]);
    expect(JSON.stringify(payload)).not.toContain('password-hash');
    expect(JSON.stringify(payload)).not.toContain('reset-token');
  });

  it('does not send a message for an invalid recipient id', () => {
    const sendMessage = vi.fn();

    sendApprovalMessage({ sendMessage }, { id: 7 }, { title: 'Approval' });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('assignee queries', () => {
  it('does not pass unsupported repository options from persisted query values', async () => {
    const find = vi.fn().mockResolvedValue([{ id: 42 }]);
    const processor = createUserProcessor(find);

    await expect(
      parseAssignees(
        {
          id: 1,
          config: {
            assignees: [
              {
                filter: { id: 42 },
                appends: ['positions'],
                sort: [undefined],
                fields: [undefined],
              },
            ],
          },
        },
        processor,
      ),
    ).resolves.toEqual([42]);

    expect(find).toHaveBeenCalledWith({
      filter: { id: 42 },
      fields: ['id'],
      transaction: 'transaction',
    });
  });

  it.each(['$in', '$notIn', '$match', '$notMatch', '$anyOf', '$noneOf', '$childIn', '$childNotIn', '$dateBetween'])(
    'turns an unresolved %s value into a no-match user filter',
    async (operator) => {
      const find = vi.fn().mockResolvedValue([]);
      const processor = createUserProcessor(find);

      await expect(
        parseAssignees(
          {
            id: 1,
            config: { assignees: [{ filter: { id: { [operator]: undefined } } }] },
          },
          processor,
        ),
      ).resolves.toEqual([]);

      expect(find).toHaveBeenCalledWith({
        filter: { id: { $in: [] } },
        fields: ['id'],
        transaction: 'transaction',
      });
    },
  );

  it('turns an unresolved filter array value into a no-match user filter', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const processor = createUserProcessor(find);

    await expect(
      parseAssignees(
        {
          id: 1,
          config: { assignees: [{ filter: { $and: [{ id: 42 }, undefined] } }] },
        },
        processor,
      ),
    ).resolves.toEqual([]);

    expect(find).toHaveBeenCalledWith({
      filter: { id: { $in: [] } },
      fields: ['id'],
      transaction: 'transaction',
    });
  });

  it('rejects null values inside array operators', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const processor = createUserProcessor(find);

    await expect(
      parseAssignees(
        {
          id: 1,
          config: { assignees: [{ filter: { id: { $in: [42, null] } } }] },
        },
        processor,
      ),
    ).resolves.toEqual([]);

    expect(find).toHaveBeenCalledWith({
      filter: { id: { $in: [] } },
      fields: ['id'],
      transaction: 'transaction',
    });
  });

  it('applies the same filter guard to carbon copy queries', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const processor = createUserProcessor(find);

    await expect(
      parsePerson({
        node: { id: 1, config: { carbonCopyPerson: [{ filter: { id: { $notIn: undefined } } }] } },
        processor,
        keyName: 'carbonCopyPerson',
      }),
    ).resolves.toEqual([]);

    expect(find).toHaveBeenCalledWith({
      filter: { id: { $in: [] } },
      fields: ['id'],
      transaction: 'transaction',
    });
  });
});
