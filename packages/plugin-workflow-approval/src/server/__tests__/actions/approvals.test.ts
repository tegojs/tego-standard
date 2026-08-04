import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { waitForFastAssertion, waitForWorkflowIdle } from '../../../../../module-workflow/src/server/__tests__/utils';
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
  let collectionName: string;
  let detailsCollectionName: string;
  let accountItemsCollectionName: string;
  let tagsCollectionName: string;
  let mainRepo;
  let detailsRepo;
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
    accountItemsRepo = db.getCollection(accountItemsCollectionName).repository;
    tagsRepo = db.getCollection(tagsCollectionName).repository;
    workflowModel = db.getCollection('workflows').model;

    const user = await db.getCollection('users').model.create({ nickname: `approval-copy-${suffix}` });
    agent = app.agent().login(user);
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

    expect(getSummaryDetails(approval.summary)).toEqual(normalizeDetails(copied.get('details')));
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
});
