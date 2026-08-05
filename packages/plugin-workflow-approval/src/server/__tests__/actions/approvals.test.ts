import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database, { mockDatabase, SequelizeDataSource } from '@tego/server';

import { vi } from 'vitest';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
import { approvals as approvalActions } from '../../actions/approvals';
import approvalExecutionsCollection from '../../collections/approvalExecutions';
import approvalRecordsCollection from '../../collections/approvalRecords';
import approvalsCollection from '../../collections/approvals';
import workflowsCollection from '../../collections/workflows';
import { APPROVAL_STATUS } from '../../constants/status';
import PluginWorkflowApproval from '../../plugin';
import ApprovalTrigger from '../../triggers/Approval';

type SummaryItem = {
  key: string;
  value: unknown;
};

function getSummaryValue(summary: SummaryItem[], key: string) {
  return summary.find((item) => item.key === key)?.value;
}

function getSummaryTableColumn(summary: SummaryItem[], tableKey: string, columnKey: string) {
  const table = getSummaryValue(summary, tableKey) as SummaryItem[];
  return table.find((item) => item.key === columnKey)?.value;
}

function normalizeDetails(details: Array<{ id: unknown; amount: unknown }>) {
  return details
    .map(({ id, amount }) => ({ id: Number(id), amount: Number(amount) }))
    .sort((left, right) => left.id - right.id);
}

function getSummaryDetails(summary: SummaryItem[], tableKey = 'details') {
  const ids = getSummaryTableColumn(summary, tableKey, 'id') as unknown[];
  const amounts = getSummaryTableColumn(summary, tableKey, 'amount') as unknown[];
  return normalizeDetails(ids.map((id, index) => ({ id, amount: amounts[index] })));
}

describe('workflow approval actions', () => {
  let app: MockServer;
  let db: Database;
  let agent;
  let currentUser;
  let collectionName: string;
  let detailsCollectionName: string;
  let profilesCollectionName: string;
  let accountItemsCollectionName: string;
  let tagsCollectionName: string;
  let mainRepo;
  let detailsRepo;
  let profilesRepo;
  let accountItemsRepo;
  let tagsRepo;
  let workflowModel;

  beforeEach(async () => {
    app = await getApp({
      plugins: [PluginWorkflowApproval, 'field-formula', 'users', 'auth'],
    });
    db = app.db;
    db.collection(approvalExecutionsCollection);
    db.collection(approvalRecordsCollection);
    db.collection(approvalsCollection);
    db.extendCollection(workflowsCollection.collectionOptions, workflowsCollection.mergeOptions);
    const workflowPlugin = app.pm.get('workflow');
    if (!workflowPlugin.triggers.get('approval')) {
      workflowPlugin.triggers.register('approval', new ApprovalTrigger(workflowPlugin));
    }

    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    collectionName = `approval_copy_roots_${suffix}`;
    detailsCollectionName = `approval_copy_details_${suffix}`;
    profilesCollectionName = `approval_copy_profiles_${suffix}`;
    accountItemsCollectionName = `approval_copy_account_items_${suffix}`;
    tagsCollectionName = `approval_copy_tags_${suffix}`;

    db.collection({
      name: accountItemsCollectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { type: 'integer', name: 'amount' },
      ],
    });
    db.collection({
      name: tagsCollectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { type: 'string', name: 'name' },
      ],
    });

    db.collection({
      name: detailsCollectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { type: 'integer', name: 'amount' },
        { type: 'belongsTo', name: 'root', target: collectionName, foreignKey: 'rootId' },
      ],
    });
    db.collection({
      name: profilesCollectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { type: 'string', name: 'label' },
        { type: 'belongsTo', name: 'root', target: collectionName, foreignKey: 'rootId' },
      ],
    });
    db.collection({
      name: collectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { type: 'integer', name: 'amountA' },
        { type: 'integer', name: 'amountB' },
        { type: 'integer', name: 'itemsTotal' },
        {
          type: 'formula',
          name: 'total',
          engine: 'math.js',
          expression: 'sum([{{amountA}}, {{amountB}}])',
        },
        { type: 'hasMany', name: 'details', target: detailsCollectionName, foreignKey: 'rootId' },
        {
          type: 'belongsToMany',
          name: 'accountItems',
          target: accountItemsCollectionName,
          through: `approval_copy_root_items_${suffix}`,
          foreignKey: 'rootId',
          otherKey: 'accountItemId',
        },
        { type: 'hasOne', name: 'profile', target: profilesCollectionName, foreignKey: 'rootId' },
        {
          type: 'belongsToMany',
          name: 'tags',
          target: tagsCollectionName,
          through: `approval_copy_root_tags_${suffix}`,
          foreignKey: 'rootId',
          otherKey: 'tagId',
        },
      ],
    });
    await db.sync();

    mainRepo = db.getCollection(collectionName).repository;
    detailsRepo = db.getCollection(detailsCollectionName).repository;
    profilesRepo = db.getCollection(profilesCollectionName).repository;
    accountItemsRepo = db.getCollection(accountItemsCollectionName).repository;
    tagsRepo = db.getCollection(tagsCollectionName).repository;
    workflowModel = db.getCollection('workflows').model;

    currentUser = await db.getCollection('users').model.create({ nickname: `approval-copy-${suffix}` });
    agent = app.agent().login(currentUser);
  });

  afterEach(async () => {
    await waitForWorkflowIdle(app);
    await app.destroy();
  });

  async function createApproval(
    data: object,
    copyOptions: { isCopy?: boolean; copyAssociationValues?: string[] } = {},
    workflowConfig: { summary?: string[]; appends?: string[] } = {},
  ) {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: [
          'id',
          'total',
          'itemsTotal',
          'details',
          'details.id',
          'details.amount',
          'accountItems',
          'accountItems.id',
          'accountItems.amount',
        ],
        appends: ['details', 'accountItems', 'tags'],
        ...workflowConfig,
      },
    });
    await workflow.createNode({ type: 'echo' });

    const response = await agent.resource('approvals').create({
      values: {
        collectionName,
        data,
        status: APPROVAL_STATUS.SUBMITTED,
        workflowId: workflow.id,
        workflowKey: workflow.key,
        ...copyOptions,
      },
    });
    expect(response.status).toBe(200);

    await waitForFastAssertion(async () => {
      expect(await workflow.getExecutions()).toHaveLength(1);
    });
    await waitForWorkflowIdle(app);

    const approvalId = response.body.data?.id ?? response.body.id;
    const approval = await db.getRepository('approvals').findOne({ filterByTk: approvalId });
    return approval;
  }

  async function createApprovalInTransaction(
    transaction,
    workflow,
    data: object,
    targetCollectionName = collectionName,
  ) {
    const ctx: any = {
      action: {
        params: {
          values: {
            collectionName: targetCollectionName,
            data,
            status: APPROVAL_STATUS.SUBMITTED,
            workflowId: workflow.id,
            workflowKey: workflow.key,
          },
        },
        mergeParams(params) {
          this.params = {
            ...this.params,
            ...params,
            values: {
              ...this.params.values,
              ...params.values,
            },
          };
        },
      },
      body: undefined,
      db,
      logger: app.logger,
      state: {
        currentRole: 'root',
        currentUser,
      },
      tego: app,
      transaction,
      throw(status, message) {
        const error: any = new Error(message);
        error.status = status;
        throw error;
      },
    };

    await approvalActions.create(ctx, async () => undefined);
    return ctx.body;
  }

  it('copies a source root id into a new business record and summarizes the new id', async () => {
    const source = await mainRepo.create({ values: { amountA: 3, amountB: 5 } });
    const sourceId = source.get('id');

    const approval = await createApproval({
      id: sourceId,
      amountA: 3,
      amountB: 5,
    });
    const copied = await mainRepo.findOne({ filterByTk: approval.dataKey });

    expect(copied.get('id')).not.toBe(sourceId);
    expect(`${approval.dataKey}`).toBe(`${copied.get('id')}`);
    expect(getSummaryValue(approval.summary, 'id')).toBe(copied.get('id'));
  });

  it('summarizes persisted formula and new hasMany details instead of source payload values', async () => {
    const source = await mainRepo.create({ values: { amountA: 7, amountB: 13 } });
    await Promise.all([7, 13].map((amount) => detailsRepo.create({ values: { amount, rootId: source.get('id') } })));
    const sourceWithDetails = await mainRepo.findOne({
      filterByTk: source.get('id'),
      appends: ['details'],
    });
    const sourceDetails = sourceWithDetails.get('details');
    const sourceDetailIds = sourceDetails.map((detail) => detail.id);

    const approval = await createApproval({
      id: source.get('id'),
      amountA: 7,
      amountB: 13,
      total: 999,
      details: sourceDetails.map((detail) => ({ id: detail.id, amount: detail.amount })),
    });
    const copied = await mainRepo.findOne({
      filterByTk: approval.dataKey,
      appends: ['details'],
    });
    const copiedDetails = normalizeDetails(copied.get('details'));
    const copiedDetailIds = copiedDetails.map((detail) => detail.id);
    const copiedAmounts = copiedDetails.map((detail) => detail.amount).sort((left, right) => left - right);

    expect(copied.get('total')).toBe(20);
    expect(copiedDetails).toHaveLength(sourceDetails.length);
    expect(copiedDetailIds.every((id) => !sourceDetailIds.includes(id))).toBe(true);
    expect(copiedAmounts).toEqual([7, 13]);
    expect.soft(getSummaryValue(approval.summary, 'total')).toBe(copied.get('total'));
    expect.soft(getSummaryDetails(approval.summary)).toEqual(copiedDetails);
  });

  it('loads associations required by the summary when workflow appends are empty', async () => {
    const source = await mainRepo.create({ values: { amountA: 11, amountB: 17 } });
    await detailsRepo.create({ values: { amount: 28, rootId: source.get('id') } });
    const sourceWithDetails = await mainRepo.findOne({
      filterByTk: source.get('id'),
      appends: ['details'],
    });

    const approval = await createApproval(
      {
        id: source.get('id'),
        amountA: 11,
        amountB: 17,
        details: sourceWithDetails.get('details').map((detail) => ({ id: detail.id, amount: detail.amount })),
      },
      {},
      {
        summary: ['details', 'details.id', 'details.amount'],
        appends: [],
      },
    );
    const copied = await mainRepo.findOne({
      filterByTk: approval.dataKey,
      appends: ['details'],
    });

    const copiedDetails = normalizeDetails(copied.get('details'));
    expect(getSummaryDetails(approval.summary)).toEqual(copiedDetails);

    const approvalExecution = await db.getRepository('approvalExecutions').findOne({
      filter: { approvalId: approval.id },
      appends: ['execution'],
    });
    expect(getSummaryDetails(approvalExecution.get('summary'))).toEqual(copiedDetails);
    expect(getSummaryDetails(approvalExecution.get('execution').context.summary)).toEqual(copiedDetails);
  });

  it('clones selected belongsToMany details but preserves unselected shared associations', async () => {
    const sourceAccountItem = await accountItemsRepo.create({ values: { amount: 26667 } });
    const sharedTag = await tagsRepo.create({ values: { name: 'shared' } });
    const source = await mainRepo.create({
      values: {
        amountA: 1,
        amountB: 2,
        itemsTotal: 26667,
        accountItems: [{ id: sourceAccountItem.get('id'), amount: 26667 }],
        tags: [{ id: sharedTag.get('id'), name: 'shared' }],
      },
    });

    const approval = await createApproval(
      {
        id: source.get('id'),
        amountA: 1,
        amountB: 2,
        itemsTotal: 12345,
        accountItems: [{ id: sourceAccountItem.get('id'), amount: 12345 }],
        tags: [{ id: sharedTag.get('id'), name: 'shared' }],
      },
      {
        isCopy: true,
        copyAssociationValues: ['accountItems'],
      },
    );
    const copied = await mainRepo.findOne({
      filterByTk: approval.dataKey,
      appends: ['accountItems', 'tags'],
    });
    const copiedAccountItems = normalizeDetails(copied.get('accountItems'));

    expect(copiedAccountItems).toHaveLength(1);
    expect(copiedAccountItems[0].id).not.toBe(Number(sourceAccountItem.get('id')));
    expect(copiedAccountItems[0].amount).toBe(12345);
    expect(copied.get('itemsTotal')).toBe(12345);
    expect(copied.get('tags')).toHaveLength(1);
    expect(Number(copied.get('tags')[0].id)).toBe(Number(sharedTag.get('id')));
    expect.soft(getSummaryValue(approval.summary, 'itemsTotal')).toBe(copied.get('itemsTotal'));
    expect.soft(getSummaryDetails(approval.summary, 'accountItems')).toEqual(copiedAccountItems);
    expect(approval.data).not.toHaveProperty('accountItems');
    expect(approval.data).not.toHaveProperty('tags');

    const persistedSourceAccountItem = await accountItemsRepo.findOne({
      filterByTk: sourceAccountItem.get('id'),
    });
    expect(persistedSourceAccountItem.get('amount')).toBe(26667);
  });

  it('preserves primitive association ids instead of treating them as clone payloads', async () => {
    const sourceAccountItem = await accountItemsRepo.create({ values: { amount: 26667 } });

    const approval = await createApproval(
      {
        amountA: 4,
        amountB: 6,
        accountItems: [sourceAccountItem.get('id')],
      },
      {
        isCopy: true,
        copyAssociationValues: ['accountItems'],
      },
    );
    const copied = await mainRepo.findOne({
      filterByTk: approval.dataKey,
      appends: ['accountItems'],
    });

    expect(copied.get('accountItems').map((item) => Number(item.id))).toEqual([Number(sourceAccountItem.get('id'))]);
  });

  it('preserves primitive ids while cloning object payloads in a mixed association array', async () => {
    const sharedAccountItem = await accountItemsRepo.create({ values: { amount: 101 } });
    const sourceAccountItem = await accountItemsRepo.create({ values: { amount: 202 } });

    const approval = await createApproval(
      {
        amountA: 5,
        amountB: 7,
        accountItems: [sharedAccountItem.get('id'), { id: sourceAccountItem.get('id'), amount: 303 }],
      },
      {
        isCopy: true,
        copyAssociationValues: ['accountItems'],
      },
    );
    const copied = await mainRepo.findOne({
      filterByTk: approval.dataKey,
      appends: ['accountItems'],
    });
    const copiedAccountItems = normalizeDetails(copied.get('accountItems'));

    expect(copiedAccountItems).toContainEqual({ id: Number(sharedAccountItem.get('id')), amount: 101 });
    expect(copiedAccountItems.some((item) => item.id === Number(sourceAccountItem.get('id')))).toBe(false);
    expect(copiedAccountItems.some((item) => item.amount === 303)).toBe(true);

    const persistedSourceAccountItem = await accountItemsRepo.findOne({
      filterByTk: sourceAccountItem.get('id'),
    });
    expect(persistedSourceAccountItem.get('amount')).toBe(202);
  });

  it('passes primitive hasMany and hasOne ids through as existing associations', async () => {
    const source = await mainRepo.create({ values: { amountA: 8, amountB: 9 } });
    const sourceDetail = await detailsRepo.create({ values: { amount: 17, rootId: source.get('id') } });
    const sourceProfile = await profilesRepo.create({ values: { label: 'shared', rootId: source.get('id') } });

    const approval = await createApproval(
      {
        amountA: 8,
        amountB: 9,
        details: [sourceDetail.get('id')],
        profile: sourceProfile.get('id'),
      },
      {
        isCopy: true,
        copyAssociationValues: ['details', 'profile'],
      },
    );
    const copied = await mainRepo.findOne({
      filterByTk: approval.dataKey,
      appends: ['details', 'profile'],
    });

    expect(copied.get('details').map((item) => Number(item.id))).toEqual([Number(sourceDetail.get('id'))]);
    expect(Number(copied.get('profile').id)).toBe(Number(sourceProfile.get('id')));
    expect(await detailsRepo.count()).toBe(1);
    expect(await profilesRepo.count()).toBe(1);
  });

  it('rolls back the business record when approval creation fails', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA', 'amountB'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const approvalRepo = db.getRepository('approvals');
    const createSpy = vi.spyOn(approvalRepo, 'create').mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName,
          data: { amountA: 41, amountB: 59 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      createSpy.mockRestore();
    }

    expect(await mainRepo.find({ filter: { amountA: 41, amountB: 59 } })).toHaveLength(0);
  });

  it('rolls back an external business transaction when approval creation fails', async () => {
    const externalDatabase = mockDatabase({
      storage: ':memory:',
      tablePrefix: `approval_external_${Date.now()}_`,
    });
    await app.dataSourceManager.add(
      new SequelizeDataSource({
        name: 'another',
        collectionManager: { database: externalDatabase },
        resourceManager: {},
      }),
    );
    const externalCollectionName = `approval_external_roots_${Date.now()}`;
    externalDatabase.collection({
      name: externalCollectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
      ],
    });
    await externalDatabase.sync();
    const externalRepo = externalDatabase.getRepository(externalCollectionName);
    const noTimestampCollectionName = `approval_external_no_timestamp_${Date.now()}`;
    externalDatabase.collection({
      name: noTimestampCollectionName,
      timestamps: false,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
      ],
    });
    await externalDatabase.sync();
    const noTimestampRepo = externalDatabase.getRepository(noTimestampCollectionName);
    const externalQualifiedName = `another:${externalCollectionName}`;
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: externalQualifiedName,
        summary: ['amount'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const approvalRepo = db.getRepository('approvals');
    const createSpy = vi.spyOn(approvalRepo, 'create').mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 73 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      createSpy.mockRestore();
    }

    expect(await externalRepo.find({ filter: { amount: 73 } })).toHaveLength(0);

    const cleanupFailureCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    const cleanupFailureDestroySpy = vi
      .spyOn(externalRepo.model, 'destroy')
      .mockRejectedValueOnce(new Error('cleanup failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 74 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(cleanupFailureDestroySpy).not.toHaveBeenCalled();
    } finally {
      cleanupFailureCreateSpy.mockRestore();
      cleanupFailureDestroySpy.mockRestore();
    }
    expect(await externalRepo.find({ filter: { amount: 74 } })).toHaveLength(0);

    const transactionStartFailureSpy = vi
      .spyOn(db.sequelize, 'transaction')
      .mockRejectedValueOnce(new Error('approval transaction unavailable'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 77 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      transactionStartFailureSpy.mockRestore();
    }
    expect(await externalRepo.find({ filter: { amount: 77 } })).toHaveLength(0);

    const rollbackFailureCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    const forceCleanup = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockRejectedValueOnce(new Error('approval rollback failed'));
    const rollbackFailureTransactionSpy = vi
      .spyOn(db.sequelize, 'transaction')
      .mockResolvedValueOnce({ rollback, forceCleanup } as any);
    const loggerErrorSpy = vi.spyOn(app.logger, 'error');
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 80 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      rollbackFailureCreateSpy.mockRestore();
      rollbackFailureTransactionSpy.mockRestore();
    }
    expect(rollback).toHaveBeenCalledOnce();
    expect(forceCleanup).toHaveBeenCalledOnce();
    const rollbackLog = loggerErrorSpy.mock.calls.find(
      ([message]) => message === 'Transaction rollback outcome is uncertain',
    );
    expect(rollbackLog?.[1]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'approval rollback failed',
          stack: expect.any(String),
        }),
      }),
    );
    expect(rollbackLog?.[1]?.error).not.toBeInstanceOf(Error);
    loggerErrorSpy.mockRestore();
    expect(await externalRepo.find({ filter: { amount: 80 } })).toHaveLength(0);

    const noTimestampQualifiedName = `another:${noTimestampCollectionName}`;
    const noTimestampWorkflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: noTimestampQualifiedName,
        summary: ['amount'],
        appends: [],
      },
    });
    await noTimestampWorkflow.createNode({ type: 'echo' });
    const noTimestampCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: noTimestampQualifiedName,
          data: { amount: 81 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: noTimestampWorkflow.id,
          workflowKey: noTimestampWorkflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      noTimestampCreateSpy.mockRestore();
    }
    expect(await noTimestampRepo.find({ filter: { amount: 81 } })).toHaveLength(0);

    const concurrentCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    const originalDestroy = externalRepo.model.destroy.bind(externalRepo.model);
    const concurrentDestroySpy = vi.spyOn(externalRepo.model, 'destroy').mockImplementation(async (options: any) => {
      const dataKey = options.where.id;
      await externalRepo.update({
        filterByTk: dataKey,
        values: { amount: 78 },
      });
      return originalDestroy(options);
    });
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 79 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(concurrentDestroySpy).not.toHaveBeenCalled();
    } finally {
      concurrentCreateSpy.mockRestore();
      concurrentDestroySpy.mockRestore();
    }
    expect(await externalRepo.find({ filter: { amount: 78 } })).toHaveLength(0);

    const successWorkflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: externalQualifiedName,
        summary: ['amount'],
        appends: [],
      },
    });
    await successWorkflow.createNode({ type: 'echo' });
    const successResponse = await agent.resource('approvals').create({
      values: {
        collectionName: externalQualifiedName,
        data: { amount: 75 },
        status: APPROVAL_STATUS.SUBMITTED,
        workflowId: successWorkflow.id,
        workflowKey: successWorkflow.key,
      },
    });
    expect(successResponse.status).toBe(200);
    await waitForFastAssertion(async () => {
      expect(await successWorkflow.getExecutions()).toHaveLength(1);
    });
    await waitForWorkflowIdle(app);
    const successApprovalId = successResponse.body.data?.id ?? successResponse.body.id;
    const successApproval = await db.getRepository('approvals').findOne({ filterByTk: successApprovalId });
    expect(getSummaryValue(successApproval.summary, 'amount')).toBe(75);
    const successExecution = await db.getRepository('approvalExecutions').findOne({
      filter: { approvalId: successApproval.id },
      appends: ['execution'],
    });
    expect(getSummaryValue(successExecution.get('summary'), 'amount')).toBe(75);
    expect(getSummaryValue(successExecution.get('execution').context.summary, 'amount')).toBe(75);

    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    let uncertainTransaction;
    const originalTransaction = db.sequelize.transaction.bind(db.sequelize);
    const transactionSpy = vi.spyOn(db.sequelize, 'transaction').mockImplementationOnce(async (...args: any[]) => {
      uncertainTransaction = await originalTransaction(...args);
      const originalCommit = uncertainTransaction.commit.bind(uncertainTransaction);
      vi.spyOn(uncertainTransaction, 'commit').mockImplementationOnce(async () => {
        await originalCommit();
        throw new Error('approval commit uncertain');
      });
      return uncertainTransaction;
    });
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 76 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: successWorkflow.id,
          workflowKey: successWorkflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      transactionSpy.mockRestore();
      await uncertainTransaction?.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
    expect(await externalRepo.find({ filter: { amount: 76 } })).toHaveLength(1);
    const retainedBusinessRecord = await externalRepo.findOne({ filter: { amount: 76 } });
    expect(
      await db.getRepository('approvals').find({
        filter: {
          collectionName: externalQualifiedName,
          dataKey: retainedBusinessRecord.get('id'),
        },
      }),
    ).toHaveLength(1);

    let uncertainBusinessTransaction;
    const originalExternalTransaction = externalDatabase.sequelize.transaction.bind(externalDatabase.sequelize);
    const businessCommitFailureSpy = vi
      .spyOn(externalDatabase.sequelize, 'transaction')
      .mockImplementationOnce(async (...args: any[]) => {
        uncertainBusinessTransaction = await originalExternalTransaction(...args);
        const originalCommit = uncertainBusinessTransaction.commit.bind(uncertainBusinessTransaction);
        vi.spyOn(uncertainBusinessTransaction, 'commit').mockImplementationOnce(async () => {
          await originalCommit();
          throw new Error('business commit uncertain');
        });
        return uncertainBusinessTransaction;
      });
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 82 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: successWorkflow.id,
          workflowKey: successWorkflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      businessCommitFailureSpy.mockRestore();
      await uncertainBusinessTransaction?.rollback().catch(() => undefined);
    }
    expect(await externalRepo.find({ filter: { amount: 82 } })).toHaveLength(1);
    const uncertainBusinessRecord = await externalRepo.findOne({ filter: { amount: 82 } });
    expect(
      await db.getRepository('approvals').find({
        filter: {
          collectionName: externalQualifiedName,
          dataKey: uncertainBusinessRecord.get('id'),
        },
      }),
    ).toHaveLength(0);
    await waitForWorkflowIdle(app);

    const failedWorkflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    let failedApprovalTransaction;
    let queryInterfaceCommitSpy;
    const originalApprovalTransaction = db.sequelize.transaction.bind(db.sequelize);
    const approvalCommitFailureSpy = vi
      .spyOn(db.sequelize, 'transaction')
      .mockImplementationOnce(async (...args: any[]) => {
        failedApprovalTransaction = await originalApprovalTransaction(...args);
        queryInterfaceCommitSpy = vi
          .spyOn(db.sequelize.getQueryInterface(), 'commitTransaction')
          .mockRejectedValueOnce(new Error('approval commit failed before database commit'));
        return failedApprovalTransaction;
      });
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalQualifiedName,
          data: { amount: 83 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: successWorkflow.id,
          workflowKey: successWorkflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(failedWorkflowTriggerSpy).not.toHaveBeenCalled();
      expect(await externalRepo.find({ filter: { amount: 83 } })).toHaveLength(1);
    } finally {
      approvalCommitFailureSpy.mockRestore();
      queryInterfaceCommitSpy?.mockRestore();
      await failedApprovalTransaction?.rollback().catch(() => undefined);
      failedWorkflowTriggerSpy.mockRestore();
    }
  });

  it('rolls back newly created external associations when approval creation fails', async () => {
    const externalDatabase = mockDatabase({
      storage: ':memory:',
      tablePrefix: `approval_external_associations_${Date.now()}_`,
    });
    await app.dataSourceManager.add(
      new SequelizeDataSource({
        name: 'externalAssociations',
        collectionManager: { database: externalDatabase },
        resourceManager: {},
      }),
    );

    const externalRootName = `approval_external_association_roots_${Date.now()}`;
    const externalDetailName = `approval_external_association_details_${Date.now()}`;
    const externalProfileName = `approval_external_association_profiles_${Date.now()}`;
    const externalNestedProfileName = `approval_external_nested_profiles_${Date.now()}`;
    externalDatabase.collection({
      name: externalDetailName,
      timestamps: false,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
        { type: 'belongsTo', name: 'root', target: externalRootName, foreignKey: 'rootId' },
        { type: 'hasOne', name: 'profile', target: externalNestedProfileName, foreignKey: 'detailId' },
      ],
    });
    externalDatabase.collection({
      name: externalProfileName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'label', type: 'string' },
        { type: 'belongsTo', name: 'root', target: externalRootName, foreignKey: 'rootId' },
      ],
    });
    externalDatabase.collection({
      name: externalNestedProfileName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'label', type: 'string' },
        { type: 'belongsTo', name: 'detail', target: externalDetailName, foreignKey: 'detailId' },
      ],
    });
    externalDatabase.collection({
      name: externalRootName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
        { type: 'hasMany', name: 'details', target: externalDetailName, foreignKey: 'rootId', onDelete: 'CASCADE' },
        { type: 'hasOne', name: 'profile', target: externalProfileName, foreignKey: 'rootId', onDelete: 'CASCADE' },
      ],
    });
    await externalDatabase.sync();

    const externalRootRepo = externalDatabase.getRepository(externalRootName);
    const externalDetailRepo = externalDatabase.getRepository(externalDetailName);
    const externalProfileRepo = externalDatabase.getRepository(externalProfileName);
    const externalNestedProfileRepo = externalDatabase.getRepository(externalNestedProfileName);
    const externalCollectionName = `externalAssociations:${externalRootName}`;
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: externalCollectionName,
        summary: ['amount', 'details', 'profile'],
        appends: ['details', 'profile'],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const approvalRepo = db.getRepository('approvals');
    const createSpy = vi.spyOn(approvalRepo, 'create').mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalCollectionName,
          data: {
            amount: 42,
            details: [{ amount: 20, profile: { label: 'nested' } }, { amount: 22 }],
            profile: { label: 'new' },
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      createSpy.mockRestore();
    }

    expect(await externalRootRepo.find({ filter: { amount: 42 } })).toHaveLength(0);
    expect(await externalDetailRepo.find({ filter: { amount: 20 } })).toHaveLength(0);
    expect(await externalNestedProfileRepo.find({ filter: { label: 'nested' } })).toHaveLength(0);
    expect(await externalProfileRepo.find({ filter: { label: 'new' } })).toHaveLength(0);

    const existingRoot = await externalRootRepo.create({ values: { amount: 1 } });
    const existingRootId = existingRoot.get('id');
    const existingDetail = await externalDetailRepo.create({
      values: { amount: 99, rootId: existingRootId },
    });
    const existingProfile = await externalProfileRepo.create({
      values: { label: 'shared', rootId: existingRootId },
    });

    const restoreCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalCollectionName,
          data: {
            amount: 43,
            details: [existingDetail.get('id')],
            profile: existingProfile.get('id'),
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      restoreCreateSpy.mockRestore();
    }

    expect(await externalRootRepo.find({ filter: { amount: 43 } })).toHaveLength(0);
    expect((await externalDetailRepo.findOne({ filterByTk: existingDetail.get('id') })).get('rootId')).toBe(
      existingRootId,
    );
    expect((await externalProfileRepo.findOne({ filterByTk: existingProfile.get('id') })).get('rootId')).toBe(
      existingRootId,
    );

    const nestedSourceDetail = await externalDetailRepo.create({
      values: { amount: 100, rootId: existingRootId },
    });
    const nestedSourceProfile = await externalNestedProfileRepo.create({
      values: { label: 'shared-nested', detailId: nestedSourceDetail.get('id') },
    });
    const nestedRestoreCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalCollectionName,
          data: {
            amount: 45,
            details: [{ amount: 23, profile: nestedSourceProfile.get('id') }],
            profile: { label: 'new-nested-root-profile' },
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      nestedRestoreCreateSpy.mockRestore();
    }

    expect(await externalRootRepo.find({ filter: { amount: 45 } })).toHaveLength(0);
    expect(await externalDetailRepo.find({ filter: { amount: 23 } })).toHaveLength(0);
    expect(
      (await externalNestedProfileRepo.findOne({ filterByTk: nestedSourceProfile.get('id') })).get('detailId'),
    ).toBe(nestedSourceDetail.get('id'));

    const concurrentCreateSpy = vi
      .spyOn(approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: externalCollectionName,
          data: {
            amount: 44,
            details: [{ amount: 21 }],
            profile: { label: 'concurrent' },
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      concurrentCreateSpy.mockRestore();
    }

    expect(await externalRootRepo.find({ filter: { amount: 44 } })).toHaveLength(0);
    expect(await externalDetailRepo.find({ filter: { amount: 21 } })).toHaveLength(0);
  });

  it('does not trigger a workflow when the same-database transaction fails before commit', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA', 'amountB'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    const queryInterfaceCommitSpy = vi
      .spyOn(db.sequelize.getQueryInterface(), 'commitTransaction')
      .mockRejectedValueOnce(new Error('same-database commit failed before database commit'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName,
          data: { amountA: 84, amountB: 16 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
    } finally {
      queryInterfaceCommitSpy.mockRestore();
      workflowTriggerSpy.mockRestore();
    }
  });

  it('waits for the root transaction when approval creation uses a nested transaction', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA', 'amountB'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const rootTransaction = await db.sequelize.transaction();
    const nestedTransaction = await db.sequelize.transaction({ transaction: rootTransaction });
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    try {
      await createApprovalInTransaction(nestedTransaction, workflow, { amountA: 85, amountB: 15 });
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      await nestedTransaction.commit();
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      await rootTransaction.commit();
      expect(workflowTriggerSpy).toHaveBeenCalledOnce();
    } finally {
      await rootTransaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('discards deferred workflow triggers when a nested transaction rolls back', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA', 'amountB'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const rootTransaction = await db.sequelize.transaction();
    const nestedTransaction = await db.sequelize.transaction({ transaction: rootTransaction });
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    try {
      await createApprovalInTransaction(nestedTransaction, workflow, { amountA: 87, amountB: 13 });
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      await nestedTransaction.rollback();
      await rootTransaction.commit();

      expect(workflowTriggerSpy).not.toHaveBeenCalled();
    } finally {
      await rootTransaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('does not trigger a workflow when an external root transaction fails before commit', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA', 'amountB'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const transaction = await db.sequelize.transaction();
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    const queryInterfaceCommitSpy = vi
      .spyOn(db.sequelize.getQueryInterface(), 'commitTransaction')
      .mockRejectedValueOnce(new Error('external transaction commit failed before database commit'));
    try {
      await createApprovalInTransaction(transaction, workflow, { amountA: 86, amountB: 14 });
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      await expect(transaction.commit()).rejects.toThrow('external transaction commit failed before database commit');
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
    } finally {
      queryInterfaceCommitSpy.mockRestore();
      await transaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('reuses an existing approval transaction for cross-database creation', async () => {
    const externalDatabase = mockDatabase({
      storage: ':memory:',
      tablePrefix: `approval_external_inherited_${Date.now()}_`,
    });
    await app.dataSourceManager.add(
      new SequelizeDataSource({
        name: 'externalInherited',
        collectionManager: { database: externalDatabase },
        resourceManager: {},
      }),
    );

    const externalCollectionName = `approval_external_inherited_roots_${Date.now()}`;
    externalDatabase.collection({
      name: externalCollectionName,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
      ],
    });
    await externalDatabase.sync();

    const qualifiedCollectionName = `externalInherited:${externalCollectionName}`;
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: qualifiedCollectionName,
        summary: ['amount'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const rootTransaction = await db.sequelize.transaction();
    const approvalTransactionSpy = vi.spyOn(db.sequelize, 'transaction');
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    try {
      const approval = await createApprovalInTransaction(
        rootTransaction,
        workflow,
        { amount: 91 },
        qualifiedCollectionName,
      );
      const approvalId = approval.id ?? approval.get?.('id');

      expect(approvalTransactionSpy).not.toHaveBeenCalled();
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
      expect(await db.getRepository('approvals').findOne({ filterByTk: approvalId })).toBeNull();

      await rootTransaction.commit();

      expect(workflowTriggerSpy).toHaveBeenCalledOnce();
      expect(await db.getRepository('approvals').findOne({ filterByTk: approvalId })).not.toBeNull();
    } finally {
      approvalTransactionSpy.mockRestore();
      await rootTransaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });
});
