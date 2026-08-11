import { JOB_STATUS } from '@tachybase/module-workflow';
import { getApp, waitForFastAssertion, waitForWorkflowIdle } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database, { mockDatabase, SequelizeDataSource } from '@tego/server';

import { vi } from 'vitest';

import { approvals as approvalActions } from '../../actions/approvals';
import approvalExecutionsCollection from '../../collections/approvalExecutions';
import approvalRecordsCollection from '../../collections/approvalRecords';
import approvalsCollection from '../../collections/approvals';
import workflowsCollection from '../../collections/workflows';
import { APPROVAL_STATUS } from '../../constants/status';
import ApprovalInstruction from '../../instructions/Approval';
import PluginWorkflowApproval from '../../plugin';
import ApprovalTrigger from '../../triggers/Approval';

type SummaryItem = {
  key: string;
  value: unknown;
};

const ROLLBACK_MESSAGE = 'Approval outcome is uncertain after inherited transaction rollback';
const APPROVAL_COMMIT_UNCERTAIN_MESSAGE =
  'Approval commit outcome is uncertain; the external business record was retained';

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
  let externalDatabases: Database[];

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
    externalDatabases = [];

    currentUser = await db.getCollection('users').model.create({ nickname: `approval-copy-${suffix}` });
    agent = app.agent().login(currentUser);
  });

  afterEach(async () => {
    try {
      await waitForWorkflowIdle(app);
    } finally {
      try {
        await Promise.all((externalDatabases ?? []).map((database) => database.close()));
      } finally {
        await app.destroy();
      }
    }
  });

  async function createApprovalWorkflow(targetCollectionName = collectionName, summary = ['amountA', 'amountB']) {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: targetCollectionName,
        summary,
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });
    return workflow;
  }

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

  it('uses plain persisted data when an association model cannot be serialized with toJSON', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: { collection: collectionName, summary: ['amountA'], appends: [] },
    });
    const persistedData = { id: 901, amountA: 31, amountB: 0 };
    const persistedRecord = {
      get: vi.fn().mockReturnValue(persistedData),
      toJSON: vi.fn(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      }),
    };
    const createSpy = vi.spyOn(mainRepo, 'create').mockResolvedValue({
      get: vi.fn().mockReturnValue(persistedData.id),
    } as any);
    const findSpy = vi
      .spyOn(mainRepo, 'findOne')
      .mockResolvedValueOnce(persistedRecord as any)
      .mockResolvedValue({
        id: persistedData.id,
        amountA: persistedData.amountA,
        amountB: persistedData.amountB,
      } as any);
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);

    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName,
          data: {
            amountA: 31,
            amountB: 0,
            approver_list: [{ id: currentUser.id, nickname: currentUser.nickname, positions: [] }],
          },
          status: APPROVAL_STATUS.DRAFT,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });

      expect(response.status).toBe(200);
      expect(persistedRecord.get).toHaveBeenCalledWith({ plain: true });
    } finally {
      createSpy.mockRestore();
      findSpy.mockRestore();
      workflowTriggerSpy.mockRestore();
    }
  });

  it('initiates an approval through a real approval instruction node', async () => {
    (app as any).messageManager = { sendMessage: vi.fn() };
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA'],
        appends: [],
      },
    });
    const workflowPlugin = app.pm.get('workflow');
    if (!workflowPlugin.instructions.get('approval')) {
      workflowPlugin.instructions.register('approval', new ApprovalInstruction(workflowPlugin));
    }
    const mappingNode = await workflow.createNode({
      type: 'data-mapping',
      config: {
        type: 'js',
        code: 'ctx.body = { ok: true };',
      },
    });
    const node = await workflow.createNode({
      type: 'approval',
      config: {
        assignees: [currentUser.id],
        negotiation: 0,
        order: false,
        branchMode: false,
        applyDetail: 'approval-detail',
      },
      upstreamId: mappingNode.id,
    });
    await mappingNode.setDownstream(node);

    const response = await agent.resource('approvals').create({
      values: {
        collectionName,
        data: { amountA: 17, amountB: 0 },
        status: APPROVAL_STATUS.SUBMITTED,
        workflowId: workflow.id,
        workflowKey: workflow.key,
      },
    });

    expect(response.status).toBe(200);
    await waitForFastAssertion(async () => {
      const [execution] = await workflow.getExecutions();
      expect(execution).toBeTruthy();
      const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
      expect(jobs).toHaveLength(2);
      const mappingJob = jobs.find((job) => job.nodeId === mappingNode.id);
      if (!mappingJob) {
        throw new Error('data mapping job was not created');
      }
      expect(mappingJob.status).toBe(1);
      const approvalJob = jobs.find((job) => job.nodeId === node.id);
      if (!approvalJob) {
        throw new Error('approval job was not created');
      }
      expect(approvalJob.status).toBe(0);
      const approvalRecords = await db.getRepository('approvalRecords').find({
        filter: { jobId: approvalJob.id },
      });
      expect(approvalRecords).toHaveLength(1);
      expect(approvalRecords[0].userId).toBe(currentUser.id);
    });
    await waitForWorkflowIdle(app);
  });

  it('keeps approval initiation alive when a mapping source has no query result', async () => {
    (app as any).messageManager = { sendMessage: vi.fn() };
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA'],
        appends: [],
      },
    });
    const workflowPlugin = app.pm.get('workflow');
    if (!workflowPlugin.instructions.get('approval')) {
      workflowPlugin.instructions.register('approval', new ApprovalInstruction(workflowPlugin));
    }
    const queryNode = await workflow.createNode({
      type: 'query',
      config: {
        collection: collectionName,
        params: {
          filter: { id: { $eq: -1 } },
        },
        multiple: false,
      },
    });
    const mappingNode = await workflow.createNode({
      type: 'data-mapping',
      config: {
        sourceArray: [
          {
            keyName: 'firstPersonArray',
            sourcePath: `{{$jobsMapByNodeKey.${queryNode.key}}}`,
          },
        ],
        type: 'js',
        code: `const { firstPersonArray } = ctx.data;
ctx.body = [firstPersonArray].filter((subArr) => subArr.length > 0);`,
      },
      upstreamId: queryNode.id,
    });
    await queryNode.setDownstream(mappingNode);
    const approvalNode = await workflow.createNode({
      type: 'approval',
      config: {
        assignees: [currentUser.id],
        negotiation: 0,
        order: false,
        branchMode: false,
        applyDetail: 'approval-detail',
      },
      upstreamId: mappingNode.id,
    });
    await mappingNode.setDownstream(approvalNode);

    const response = await agent.resource('approvals').create({
      values: {
        collectionName,
        data: { amountA: 23, amountB: 0 },
        status: APPROVAL_STATUS.SUBMITTED,
        workflowId: workflow.id,
        workflowKey: workflow.key,
      },
    });

    expect(response.status).toBe(200);
    await waitForFastAssertion(async () => {
      const [execution] = await workflow.getExecutions();
      expect(execution).toBeTruthy();
      const jobs = await execution.getJobs();
      const queryJob = jobs.find((job) => job.nodeId === queryNode.id);
      const mappingJob = jobs.find((job) => job.nodeId === mappingNode.id);
      const approvalJob = jobs.find((job) => job.nodeId === approvalNode.id);
      expect(queryJob?.status).toBe(JOB_STATUS.RESOLVED);
      expect(mappingJob?.status).toBe(JOB_STATUS.RESOLVED);
      expect(approvalJob?.status).toBe(JOB_STATUS.PENDING);
      const approvalRecords = await db.getRepository('approvalRecords').find({
        filter: { jobId: approvalJob?.id },
      });
      expect(approvalRecords).toHaveLength(1);
    });
    await waitForWorkflowIdle(app);
  });

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
        mergeParams(params, strategies?: { values?: string }) {
          this.params = {
            ...this.params,
            ...params,
            values: {
              ...(strategies?.values === 'overwrite' ? {} : this.params.values),
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

  async function setupExternalApprovalCollection(options: { timestamps?: boolean } = {}) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const dataSourceName = 'another';
    const externalDatabase = mockDatabase({
      storage: ':memory:',
      tablePrefix: `approval_external_${suffix}_`,
    });
    externalDatabases.push(externalDatabase);
    await app.dataSourceManager.add(
      new SequelizeDataSource({
        name: dataSourceName,
        collectionManager: { database: externalDatabase },
        resourceManager: {},
      }),
    );

    const externalCollectionName = `approval_external_roots_${suffix}`;
    externalDatabase.collection({
      name: externalCollectionName,
      timestamps: options.timestamps ?? true,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
      ],
    });
    await externalDatabase.sync();

    const externalQualifiedName = `${dataSourceName}:${externalCollectionName}`;
    const workflow = await createApprovalWorkflow(externalQualifiedName, ['amount']);

    return {
      approvalRepo: db.getRepository('approvals'),
      externalCollectionName,
      externalDatabase,
      externalQualifiedName,
      externalRepo: externalDatabase.getRepository(externalCollectionName),
      workflow,
    };
  }

  async function submitExternalApproval(setup, amount: number) {
    return agent.resource('approvals').create({
      values: {
        collectionName: setup.externalQualifiedName,
        data: { amount },
        status: APPROVAL_STATUS.SUBMITTED,
        workflowId: setup.workflow.id,
        workflowKey: setup.workflow.key,
      },
    });
  }

  async function setupExternalAssociationApproval() {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const externalDatabase = mockDatabase({
      storage: ':memory:',
      tablePrefix: `approval_external_associations_${suffix}_`,
    });
    externalDatabases.push(externalDatabase);
    await app.dataSourceManager.add(
      new SequelizeDataSource({
        name: 'externalAssociations',
        collectionManager: { database: externalDatabase },
        resourceManager: {},
      }),
    );

    const externalRootName = `approval_external_association_roots_${suffix}`;
    const externalDetailName = `approval_external_association_details_${suffix}`;
    const externalProfileName = `approval_external_association_profiles_${suffix}`;
    const externalNestedProfileName = `approval_external_nested_profiles_${suffix}`;
    externalDatabase.collection({
      name: externalDetailName,
      timestamps: false,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'amount', type: 'integer' },
        { type: 'belongsTo', name: 'root', target: externalRootName, foreignKey: 'rootId' },
        {
          type: 'hasOne',
          name: 'profile',
          target: externalNestedProfileName,
          foreignKey: 'detailId',
        },
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
        {
          type: 'hasMany',
          name: 'details',
          target: externalDetailName,
          foreignKey: 'rootId',
          onDelete: 'CASCADE',
        },
        {
          type: 'hasOne',
          name: 'profile',
          target: externalProfileName,
          foreignKey: 'rootId',
          onDelete: 'CASCADE',
        },
      ],
    });
    await externalDatabase.sync();

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

    return {
      approvalRepo: db.getRepository('approvals'),
      externalCollectionName,
      externalDatabase,
      externalDetailRepo: externalDatabase.getRepository(externalDetailName),
      externalNestedProfileRepo: externalDatabase.getRepository(externalNestedProfileName),
      externalProfileRepo: externalDatabase.getRepository(externalProfileName),
      externalRootRepo: externalDatabase.getRepository(externalRootName),
      workflow,
    };
  }

  it('rejects a business record that does not expose its filter target key', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: {
        collection: collectionName,
        summary: ['amountA'],
        appends: [],
      },
    });
    await workflow.createNode({ type: 'echo' });

    const createdValue = { get: vi.fn().mockReturnValue(undefined) };
    const createSpy = vi.spyOn(mainRepo, 'create').mockResolvedValueOnce(createdValue as any);
    const findSpy = vi.spyOn(mainRepo, 'findOne');
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName,
          data: { amountA: 17 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      findSpy.mockRestore();
    }
  });

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

  it('rejects invalid copy association paths with a 400 response', async () => {
    const workflow = await workflowModel.create({
      enabled: true,
      type: 'approval',
      config: { collection: collectionName, summary: [], appends: [] },
    });
    await workflow.createNode({ type: 'echo' });
    const response = await agent.resource('approvals').create({
      values: {
        collectionName,
        data: { amountA: 3, details: [] },
        status: APPROVAL_STATUS.SUBMITTED,
        workflowId: workflow.id,
        workflowKey: workflow.key,
        isCopy: true,
        copyAssociationValues: [1],
      },
    });

    expect(response.status).toBe(400);
  });

  it('summarizes persisted formula and new hasMany details instead of source payload values', async () => {
    const source = await mainRepo.create({ values: { amountA: 7, amountB: 13 } });
    const sourceId = source.get('id');
    const createDetail = (amount) => detailsRepo.create({ values: { amount, rootId: sourceId } });
    await Promise.all([7, 13].map(createDetail));
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

    const approvalRepo = db.getRepository('approvals');
    const approvalCreateSpy = vi.spyOn(approvalRepo, 'create');
    let approval;
    let approvalCreateValues;
    try {
      approval = await createApproval(
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
      approvalCreateValues = approvalCreateSpy.mock.calls[0][0].values;
    } finally {
      approvalCreateSpy.mockRestore();
    }
    expect(approvalCreateValues).not.toHaveProperty('isCopy');
    expect(approvalCreateValues).not.toHaveProperty('copyAssociationValues');
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

    const copiedAccountItemIds = copied.get('accountItems').map((item) => Number(item.id));
    expect(copiedAccountItemIds).toEqual([Number(sourceAccountItem.get('id'))]);
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

    const copiedDetailIds = copied.get('details').map((item) => Number(item.id));
    expect(copiedDetailIds).toEqual([Number(sourceDetail.get('id'))]);
    expect(Number(copied.get('profile').id)).toBe(Number(sourceProfile.get('id')));
    expect(await detailsRepo.count()).toBe(1);
    expect(await profilesRepo.count()).toBe(1);
  });

  it('rolls back the business record when approval creation fails', async () => {
    const workflow = await createApprovalWorkflow();

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
    const setup = await setupExternalApprovalCollection();
    const createSpy = vi.spyOn(setup.approvalRepo, 'create');
    createSpy.mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await submitExternalApproval(setup, 73);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      createSpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 73 } })).toHaveLength(0);
  });

  it('does not run direct cleanup after an external business transaction rolls back', async () => {
    const setup = await setupExternalApprovalCollection();
    const creationError = new Error('approval create failed');
    const cleanupError = new Error('cleanup failed');
    const createSpy = vi.spyOn(setup.approvalRepo, 'create').mockRejectedValueOnce(creationError);
    const externalModel = setup.externalRepo.model;
    const destroySpy = vi.spyOn(externalModel, 'destroy').mockRejectedValueOnce(cleanupError);
    try {
      const response = await submitExternalApproval(setup, 74);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(destroySpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      destroySpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 74 } })).toHaveLength(0);
  });

  it('removes the external record when the approval transaction cannot start', async () => {
    const setup = await setupExternalApprovalCollection();
    const transactionSpy = vi
      .spyOn(db.sequelize, 'transaction')
      .mockRejectedValueOnce(new Error('approval transaction unavailable'));
    try {
      const response = await submitExternalApproval(setup, 77);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      transactionSpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 77 } })).toHaveLength(0);
  });

  it('force-cleans the approval transaction when rollback fails', async () => {
    const setup = await setupExternalApprovalCollection();
    const creationError = new Error('approval create failed');
    const createSpy = vi.spyOn(setup.approvalRepo, 'create').mockRejectedValueOnce(creationError);
    const forceCleanup = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockRejectedValueOnce(new Error('approval rollback failed'));
    const transactionSpy = vi
      .spyOn(db.sequelize, 'transaction')
      .mockResolvedValueOnce({ rollback, forceCleanup } as any);
    const loggerErrorSpy = vi.spyOn(app.logger, 'error');
    try {
      const response = await submitExternalApproval(setup, 80);
      expect(response.status).toBeGreaterThanOrEqual(400);
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
    } finally {
      createSpy.mockRestore();
      transactionSpy.mockRestore();
      loggerErrorSpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 80 } })).toHaveLength(0);
  });

  it('rolls back records in an external collection without timestamps', async () => {
    const setup = await setupExternalApprovalCollection({ timestamps: false });
    const creationError = new Error('approval create failed');
    const createSpy = vi.spyOn(setup.approvalRepo, 'create').mockRejectedValueOnce(creationError);
    try {
      const response = await submitExternalApproval(setup, 81);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      createSpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 81 } })).toHaveLength(0);
  });

  it('does not destroy a concurrently changed external record outside the transaction', async () => {
    const setup = await setupExternalApprovalCollection();
    const creationError = new Error('approval create failed');
    const createSpy = vi.spyOn(setup.approvalRepo, 'create').mockRejectedValueOnce(creationError);
    const originalDestroy = setup.externalRepo.model.destroy.bind(setup.externalRepo.model);
    const destroySpy = vi.spyOn(setup.externalRepo.model, 'destroy').mockImplementation(async (options: any) => {
      const dataKey = options.where.id;
      await setup.externalRepo.update({
        filterByTk: dataKey,
        values: { amount: 78 },
      });
      return originalDestroy(options);
    });
    try {
      const response = await submitExternalApproval(setup, 79);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(destroySpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      destroySpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 78 } })).toHaveLength(0);
  });

  it('creates an external approval and summarizes persisted data', async () => {
    const setup = await setupExternalApprovalCollection();
    const response = await submitExternalApproval(setup, 75);

    expect(response.status).toBe(200);
    await waitForFastAssertion(async () => {
      expect(await setup.workflow.getExecutions()).toHaveLength(1);
    });
    await waitForWorkflowIdle(app);
    const approvalId = response.body.data?.id ?? response.body.id;
    const approval = await db.getRepository('approvals').findOne({ filterByTk: approvalId });
    expect(getSummaryValue(approval.summary, 'amount')).toBe(75);
    const execution = await db.getRepository('approvalExecutions').findOne({
      filter: { approvalId: approval.id },
      appends: ['execution'],
    });
    expect(getSummaryValue(execution.get('summary'), 'amount')).toBe(75);
    expect(getSummaryValue(execution.get('execution').context.summary, 'amount')).toBe(75);
  });

  it('retains the external record when approval commit outcome is uncertain', async () => {
    const setup = await setupExternalApprovalCollection();
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    const loggerErrorSpy = vi.spyOn(app.logger, 'error');
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
      const response = await submitExternalApproval(setup, 76);
      expect(response.status).toBeGreaterThanOrEqual(400);
      const expectedError = expect.objectContaining({ message: 'approval commit uncertain' });
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        APPROVAL_COMMIT_UNCERTAIN_MESSAGE,
        expect.objectContaining({ error: expectedError }),
      );
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
    } finally {
      transactionSpy.mockRestore();
      if (uncertainTransaction) {
        await uncertainTransaction.rollback().catch(() => undefined);
      }
      loggerErrorSpy.mockRestore();
      workflowTriggerSpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 76 } })).toHaveLength(1);
    const retainedBusinessRecord = await setup.externalRepo.findOne({ filter: { amount: 76 } });
    expect(
      await db.getRepository('approvals').find({
        filter: {
          collectionName: setup.externalQualifiedName,
          dataKey: retainedBusinessRecord.get('id'),
        },
      }),
    ).toHaveLength(1);
  });

  it('rolls back approval data when business commit outcome is uncertain', async () => {
    const setup = await setupExternalApprovalCollection();
    let uncertainBusinessTransaction;
    const loggerErrorSpy = vi.spyOn(app.logger, 'error');
    const originalTransaction = setup.externalDatabase.sequelize.transaction.bind(setup.externalDatabase.sequelize);
    const transactionSpy = vi
      .spyOn(setup.externalDatabase.sequelize, 'transaction')
      .mockImplementationOnce(async (...args: any[]) => {
        uncertainBusinessTransaction = await originalTransaction(...args);
        const originalCommit = uncertainBusinessTransaction.commit.bind(uncertainBusinessTransaction);
        vi.spyOn(uncertainBusinessTransaction, 'commit').mockImplementationOnce(async () => {
          await originalCommit();
          throw new Error('business commit uncertain');
        });
        return uncertainBusinessTransaction;
      });
    try {
      const response = await submitExternalApproval(setup, 82);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Business commit outcome is uncertain; approval transaction was rolled back',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'business commit uncertain' }),
        }),
      );
      expect(loggerErrorSpy).not.toHaveBeenCalledWith(
        'Business commit outcome is uncertain and transaction cleanup failed',
        expect.anything(),
      );
    } finally {
      transactionSpy.mockRestore();
      if (uncertainBusinessTransaction) {
        await uncertainBusinessTransaction.rollback().catch(() => undefined);
      }
      loggerErrorSpy.mockRestore();
    }

    expect(await setup.externalRepo.find({ filter: { amount: 82 } })).toHaveLength(1);
    const retainedBusinessRecord = await setup.externalRepo.findOne({ filter: { amount: 82 } });
    expect(
      await db.getRepository('approvals').find({
        filter: {
          collectionName: setup.externalQualifiedName,
          dataKey: retainedBusinessRecord.get('id'),
        },
      }),
    ).toHaveLength(0);
    await waitForWorkflowIdle(app);
  });

  it('retains the external record when approval commit fails before the database commit', async () => {
    const setup = await setupExternalApprovalCollection();
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    let failedApprovalTransaction;
    let queryInterfaceCommitSpy;
    const originalTransaction = db.sequelize.transaction.bind(db.sequelize);
    const transactionSpy = vi.spyOn(db.sequelize, 'transaction').mockImplementationOnce(async (...args: any[]) => {
      failedApprovalTransaction = await originalTransaction(...args);
      queryInterfaceCommitSpy = vi
        .spyOn(db.sequelize.getQueryInterface(), 'commitTransaction')
        .mockRejectedValueOnce(new Error('approval commit failed before database commit'));
      return failedApprovalTransaction;
    });
    try {
      const response = await submitExternalApproval(setup, 83);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
      expect(await setup.externalRepo.find({ filter: { amount: 83 } })).toHaveLength(1);
    } finally {
      transactionSpy.mockRestore();
      queryInterfaceCommitSpy?.mockRestore();
      if (failedApprovalTransaction) {
        await failedApprovalTransaction.rollback().catch(() => undefined);
      }
      workflowTriggerSpy.mockRestore();
    }
  });

  it('rolls back newly created external associations when approval creation fails', async () => {
    const setup = await setupExternalAssociationApproval();
    const creationError = new Error('approval create failed');
    const createSpy = vi.spyOn(setup.approvalRepo, 'create').mockRejectedValueOnce(creationError);
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: setup.externalCollectionName,
          data: {
            amount: 42,
            details: [{ amount: 20, profile: { label: 'nested' } }, { amount: 22 }],
            profile: { label: 'new' },
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: setup.workflow.id,
          workflowKey: setup.workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      createSpy.mockRestore();
    }

    expect(await setup.externalRootRepo.find({ filter: { amount: 42 } })).toHaveLength(0);
    expect(await setup.externalDetailRepo.find({ filter: { amount: 20 } })).toHaveLength(0);
    const nestedProfileRepo = setup.externalNestedProfileRepo;
    const nestedProfiles = await nestedProfileRepo.find({ filter: { label: 'nested' } });
    expect(nestedProfiles).toHaveLength(0);
    expect(await setup.externalProfileRepo.find({ filter: { label: 'new' } })).toHaveLength(0);
  });

  it('restores existing external association foreign keys on failure', async () => {
    const setup = await setupExternalAssociationApproval();
    const existingRoot = await setup.externalRootRepo.create({ values: { amount: 1 } });
    const existingRootId = existingRoot.get('id');
    const existingDetail = await setup.externalDetailRepo.create({
      values: { amount: 99, rootId: existingRootId },
    });
    const existingProfile = await setup.externalProfileRepo.create({
      values: { label: 'shared', rootId: existingRootId },
    });
    const restoreCreateSpy = vi
      .spyOn(setup.approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: setup.externalCollectionName,
          data: {
            amount: 43,
            details: [existingDetail.get('id')],
            profile: existingProfile.get('id'),
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: setup.workflow.id,
          workflowKey: setup.workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      restoreCreateSpy.mockRestore();
    }

    expect(await setup.externalRootRepo.find({ filter: { amount: 43 } })).toHaveLength(0);
    const detailId = existingDetail.get('id');
    const profileId = existingProfile.get('id');
    const restoredDetail = await setup.externalDetailRepo.findOne({ filterByTk: detailId });
    const restoredProfile = await setup.externalProfileRepo.findOne({ filterByTk: profileId });
    expect(restoredDetail.get('rootId')).toBe(existingRootId);
    expect(restoredProfile.get('rootId')).toBe(existingRootId);
  });

  it('restores existing nested association foreign keys on failure', async () => {
    const setup = await setupExternalAssociationApproval();
    const existingRoot = await setup.externalRootRepo.create({ values: { amount: 1 } });
    const existingRootId = existingRoot.get('id');
    const nestedSourceDetail = await setup.externalDetailRepo.create({
      values: { amount: 100, rootId: existingRootId },
    });
    const nestedSourceProfile = await setup.externalNestedProfileRepo.create({
      values: { label: 'shared-nested', detailId: nestedSourceDetail.get('id') },
    });
    const nestedRestoreCreateSpy = vi
      .spyOn(setup.approvalRepo, 'create')
      .mockRejectedValueOnce(new Error('approval create failed'));
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName: setup.externalCollectionName,
          data: {
            amount: 45,
            details: [{ amount: 23, profile: nestedSourceProfile.get('id') }],
            profile: { label: 'new-nested-root-profile' },
          },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: setup.workflow.id,
          workflowKey: setup.workflow.key,
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      nestedRestoreCreateSpy.mockRestore();
    }

    expect(await setup.externalRootRepo.find({ filter: { amount: 45 } })).toHaveLength(0);
    expect(await setup.externalDetailRepo.find({ filter: { amount: 23 } })).toHaveLength(0);
    const restoredNestedProfile = await setup.externalNestedProfileRepo.findOne({
      filterByTk: nestedSourceProfile.get('id'),
    });
    expect(restoredNestedProfile.get('detailId')).toBe(nestedSourceDetail.get('id'));
  });

  it('does not trigger a workflow when the same-database transaction fails before commit', async () => {
    const workflow = await createApprovalWorkflow();

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

  it('keeps a committed approval successful when its deferred workflow trigger fails', async () => {
    const workflow = await createApprovalWorkflow();

    const workflowTriggerSpy = vi
      .spyOn(app.pm.get('workflow'), 'trigger')
      .mockRejectedValueOnce(new Error('deferred trigger failed'));
    const loggerErrorSpy = vi.spyOn(app.logger, 'error');
    try {
      const response = await agent.resource('approvals').create({
        values: {
          collectionName,
          data: { amountA: 63, amountB: 37 },
          status: APPROVAL_STATUS.SUBMITTED,
          workflowId: workflow.id,
          workflowKey: workflow.key,
        },
      });

      expect(response.status).toBe(200);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Deferred workflow trigger failed after approval commit',
        expect.objectContaining({
          collectionName,
          error: expect.objectContaining({ message: 'deferred trigger failed' }),
        }),
      );
    } finally {
      workflowTriggerSpy.mockRestore();
      loggerErrorSpy.mockRestore();
    }
  });

  it('waits for the root transaction when approval creation uses a nested transaction', async () => {
    const workflow = await createApprovalWorkflow();

    const rootTransaction = await db.sequelize.transaction();
    const nestedTransaction = await db.sequelize.transaction({ transaction: rootTransaction });
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    try {
      await createApprovalInTransaction(nestedTransaction, workflow, { amountA: 85, amountB: 15 });
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      await nestedTransaction.commit();
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      await rootTransaction.commit();
      await waitForFastAssertion(() => {
        expect(workflowTriggerSpy).toHaveBeenCalledOnce();
      });
    } finally {
      await rootTransaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('discards deferred workflow triggers when a nested transaction rolls back', async () => {
    const workflow = await createApprovalWorkflow();

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
    const workflow = await createApprovalWorkflow();

    const transaction = await db.sequelize.transaction();
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    const queryInterfaceCommitSpy = vi
      .spyOn(db.sequelize.getQueryInterface(), 'commitTransaction')
      .mockRejectedValueOnce(new Error('external transaction commit failed before database commit'));
    try {
      await createApprovalInTransaction(transaction, workflow, { amountA: 86, amountB: 14 });
      expect(workflowTriggerSpy).not.toHaveBeenCalled();

      const commitErrorMessage = 'external transaction commit failed before database commit';
      await expect(transaction.commit()).rejects.toThrow(commitErrorMessage);
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
    } finally {
      queryInterfaceCommitSpy.mockRestore();
      await transaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('reuses an existing approval transaction for cross-database creation', async () => {
    const setup = await setupExternalApprovalCollection();
    const rootTransaction = await db.sequelize.transaction();
    const approvalTransactionSpy = vi.spyOn(db.sequelize, 'transaction');
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    try {
      const approval = await createApprovalInTransaction(
        rootTransaction,
        setup.workflow,
        { amount: 91 },
        setup.externalQualifiedName,
      );
      const approvalId = approval.id ?? approval.get?.('id');

      expect(approvalTransactionSpy).not.toHaveBeenCalled();
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
      expect(await db.getRepository('approvals').findOne({ filterByTk: approvalId })).toBeNull();

      await rootTransaction.commit();

      await waitForFastAssertion(() => {
        expect(workflowTriggerSpy).toHaveBeenCalledOnce();
      });
      expect(await db.getRepository('approvals').findOne({ filterByTk: approvalId })).not.toBeNull();
    } finally {
      approvalTransactionSpy.mockRestore();
      await rootTransaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('logs pending approvals when an inherited approval transaction rolls back', async () => {
    const setup = await setupExternalApprovalCollection();
    const rootTransaction = await db.sequelize.transaction();
    const rollbackLoggerSpy = vi.spyOn(app.logger, 'error');
    const workflowTriggerSpy = vi.spyOn(app.pm.get('workflow'), 'trigger').mockResolvedValue(undefined);
    try {
      const firstApproval = await createApprovalInTransaction(
        rootTransaction,
        setup.workflow,
        { amount: 92 },
        setup.externalQualifiedName,
      );
      const firstApprovalId = firstApproval.id ?? firstApproval.get?.('id');
      const sharedRollback = rootTransaction.rollback;
      const secondApproval = await createApprovalInTransaction(
        rootTransaction,
        setup.workflow,
        { amount: 93 },
        setup.externalQualifiedName,
      );
      const secondApprovalId = secondApproval.id ?? secondApproval.get?.('id');

      expect(await setup.externalRepo.find({ filter: { amount: 92 } })).toHaveLength(1);
      expect(await setup.externalRepo.find({ filter: { amount: 93 } })).toHaveLength(1);
      expect(rootTransaction.rollback).toBe(sharedRollback);
      expect(await db.getRepository('approvals').findOne({ filterByTk: firstApprovalId })).toBeNull();

      await rootTransaction.rollback();
      await rootTransaction.rollback().catch(() => undefined);

      expect(rollbackLoggerSpy).toHaveBeenCalledWith(ROLLBACK_MESSAGE, {
        dataKey: firstApproval.dataKey,
        collectionName: setup.externalQualifiedName,
      });
      expect(rollbackLoggerSpy).toHaveBeenCalledWith(ROLLBACK_MESSAGE, {
        dataKey: secondApproval.dataKey,
        collectionName: setup.externalQualifiedName,
      });
      const logs = rollbackLoggerSpy.mock.calls.filter(([message]) => message === ROLLBACK_MESSAGE);
      expect(logs).toHaveLength(2);
      expect(await setup.externalRepo.find({ filter: { amount: 92 } })).toHaveLength(1);
      expect(await setup.externalRepo.find({ filter: { amount: 93 } })).toHaveLength(1);
      expect(await db.getRepository('approvals').findOne({ filterByTk: firstApprovalId })).toBeNull();
      expect(await db.getRepository('approvals').findOne({ filterByTk: secondApprovalId })).toBeNull();
      expect(workflowTriggerSpy).not.toHaveBeenCalled();
    } finally {
      rollbackLoggerSpy.mockRestore();
      await rootTransaction.rollback().catch(() => undefined);
      workflowTriggerSpy.mockRestore();
    }
  });

  it('does not update a business record before rejecting a cross-tenant approval update', async () => {
    const businessUpdateError: any = new Error('business update should not run');
    businessUpdateError.status = 409;
    const businessUpdate = vi.fn().mockRejectedValue(businessUpdateError);
    const approvalFindOne = vi.fn().mockResolvedValue(null);
    const businessCollection = {
      filterTargetKey: 'id',
      options: { tenancy: 'tenantScoped' },
      repository: { update: businessUpdate },
      model: { associations: {} },
      fields: [],
    } as any;
    const approvalSequelize = {};
    const businessSequelize = {};
    const ctx: any = {
      action: {
        resourceName: 'approvals',
        params: {
          filterByTk: 'approval-b',
          values: {
            collectionName: `main:${collectionName}`,
            data: { id: 'business-b', amountA: 999 },
            status: APPROVAL_STATUS.SUBMITTED,
          },
        },
        mergeParams: vi.fn(),
      },
      db: {
        sequelize: approvalSequelize,
        getRepository: vi.fn((name) => (name === 'approvals' ? { findOne: approvalFindOne } : undefined)),
      },
      tego: {
        dataSourceManager: {
          dataSources: new Map([['main', { collectionManager: { getCollection: () => businessCollection } }]]),
        },
      },
      state: {
        currentTenant: { id: 'tenant-a' },
        currentTenantId: 'tenant-a',
        currentRole: 'root',
      },
      transaction: { id: 'business-transaction', sequelize: businessSequelize },
      throw(status: number) {
        const error: any = new Error(`HTTP ${status}`);
        error.status = status;
        throw error;
      },
    };

    await expect(approvalActions.update(ctx, vi.fn())).rejects.toMatchObject({ status: 404 });
    expect(approvalFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'approval-b',
        filter: { tenantId: 'tenant-a' },
        context: ctx,
        transaction: undefined,
      }),
    );
    expect(businessUpdate).not.toHaveBeenCalled();
  });

  it('does not pass an external business transaction to the approval repository', async () => {
    const approvalSequelize = {};
    const businessSequelize = {};
    const businessTransaction = { id: 'business-transaction', sequelize: businessSequelize };
    const businessUpdate = vi.fn().mockResolvedValue([{ id: 'business-a', amountA: 18 }]);
    const approvalUpdate = vi.fn().mockResolvedValue([{ id: 'approval-a' }]);
    const approvalRepository = {
      findOne: vi.fn().mockResolvedValue({
        id: 'approval-a',
        collectionName: `main:${collectionName}`,
        dataKey: 'business-a',
        data: { id: 'business-a', amountA: 9 },
      }),
      update: approvalUpdate,
    };
    const ctx: any = {
      action: {
        resourceName: 'approvals',
        params: {
          filterByTk: 'approval-a',
          values: {
            collectionName: `main:${collectionName}`,
            data: { id: 'business-a', amountA: 18 },
            status: APPROVAL_STATUS.SUBMITTED,
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
      db: {
        sequelize: approvalSequelize,
        getRepository: vi.fn(() => approvalRepository),
      },
      tego: {
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: () => ({
                    filterTargetKey: 'id',
                    options: { tenancy: 'tenantScoped' },
                    repository: { update: businessUpdate },
                    model: { associations: {}, sequelize: businessSequelize },
                    fields: [],
                  }),
                },
              },
            ],
          ]),
        },
      },
      state: {
        currentTenant: { id: 'tenant-a' },
        currentTenantId: 'tenant-a',
        currentRole: 'root',
      },
      transaction: businessTransaction,
      throw(errorStatus: number) {
        const error: any = new Error(`HTTP ${errorStatus}`);
        error.status = errorStatus;
        throw error;
      },
    };

    await approvalActions.update(ctx, vi.fn());

    expect(businessUpdate).toHaveBeenCalledWith(expect.objectContaining({ transaction: businessTransaction }));
    expect(approvalUpdate).toHaveBeenCalledWith(expect.objectContaining({ transaction: undefined }));
  });

  it.each(['collection', 'record'])(
    'rejects an approval update that retargets the persisted business %s',
    async (retargetedPart) => {
      const persistedCollectionName = `main:${collectionName}`;
      const requestedCollectionName =
        retargetedPart === 'collection' ? `main:${collectionName}_shared` : persistedCollectionName;
      const requestedDataKey = retargetedPart === 'record' ? 'business-b' : 'business-a';
      const businessUpdateError: any = new Error('retargeted business update should not run');
      businessUpdateError.status = 409;
      const businessUpdate = vi.fn().mockRejectedValue(businessUpdateError);
      const approvalRepository = {
        findOne: vi.fn().mockResolvedValue({
          id: 'approval-a',
          collectionName: persistedCollectionName,
          dataKey: 'business-a',
          data: { id: 'business-a' },
        }),
        update: vi.fn(),
      };
      const ctx: any = {
        action: {
          resourceName: 'approvals',
          params: {
            filterByTk: 'approval-a',
            values: {
              collectionName: requestedCollectionName,
              data: { id: requestedDataKey, amountA: 999 },
              status: APPROVAL_STATUS.SUBMITTED,
            },
          },
          mergeParams: vi.fn(),
        },
        db: {
          getRepository: vi.fn(() => approvalRepository),
        },
        tego: {
          dataSourceManager: {
            dataSources: new Map([
              [
                'main',
                {
                  collectionManager: {
                    getCollection: vi.fn(() => ({
                      filterTargetKey: 'id',
                      options: {},
                      repository: { update: businessUpdate },
                      model: { associations: {}, primaryKeyAttributes: ['id'] },
                      fields: [],
                    })),
                  },
                },
              ],
            ]),
          },
        },
        state: {
          currentRole: 'root',
        },
        throw(errorStatus: number) {
          const error: any = new Error(`HTTP ${errorStatus}`);
          error.status = errorStatus;
          throw error;
        },
      };

      await expect(approvalActions.update(ctx, vi.fn())).rejects.toMatchObject({ status: 400 });
      expect(businessUpdate).not.toHaveBeenCalled();
      expect(approvalRepository.update).not.toHaveBeenCalled();
    },
  );

  it('accepts an equivalent numeric target key while preserving the persisted approval target', async () => {
    const persistedCollectionName = `main:${collectionName}`;
    const businessUpdate = vi.fn().mockResolvedValue([{ id: 17, amountA: 18 }]);
    const approvalUpdate = vi.fn().mockResolvedValue([{ id: 'approval-a' }]);
    const approvalRepository = {
      findOne: vi.fn().mockResolvedValue({
        id: 'approval-a',
        collectionName: persistedCollectionName,
        dataKey: '17',
        data: { id: 17, amountA: 9 },
      }),
      update: approvalUpdate,
    };
    const ctx: any = {
      action: {
        resourceName: 'approvals',
        params: {
          filterByTk: 'approval-a',
          values: {
            collectionName: persistedCollectionName,
            dataKey: 'forged-target',
            data: { id: 17, amountA: 18 },
            status: APPROVAL_STATUS.DRAFT,
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
      db: {
        getRepository: vi.fn(() => approvalRepository),
      },
      tego: {
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: vi.fn(() => ({
                    filterTargetKey: 'id',
                    options: {},
                    repository: { update: businessUpdate },
                    model: { associations: {}, primaryKeyAttributes: ['id'] },
                    fields: [],
                  })),
                },
              },
            ],
          ]),
        },
      },
      state: {
        currentRole: 'root',
      },
      throw(errorStatus: number) {
        const error: any = new Error(`HTTP ${errorStatus}`);
        error.status = errorStatus;
        throw error;
      },
    };

    await approvalActions.update(ctx, vi.fn());

    expect(businessUpdate).toHaveBeenCalledWith(expect.objectContaining({ filterByTk: 17 }));
    expect(approvalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          collectionName: persistedCollectionName,
          dataKey: '17',
        }),
      }),
    );
  });

  it('rolls back the business update when the same-database approval update fails', async () => {
    const transaction: any = {
      commit: vi.fn(),
      rollback: vi.fn(),
    };
    const sequelize: any = {
      transaction: vi.fn(async (callback) => {
        try {
          const result = await callback(transaction);
          await transaction.commit();
          return result;
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
      }),
    };
    transaction.sequelize = sequelize;

    const businessUpdate = vi.fn().mockResolvedValue([{ id: 17, amountA: 18 }]);
    const approvalUpdate = vi.fn().mockResolvedValue([]);
    const approvalRepository = {
      findOne: vi.fn().mockResolvedValue({
        id: 'approval-a',
        collectionName: `main:${collectionName}`,
        dataKey: '17',
        data: { id: 17, amountA: 9 },
      }),
      update: approvalUpdate,
    };
    const ctx: any = {
      action: {
        resourceName: 'approvals',
        params: {
          filterByTk: 'approval-a',
          values: {
            collectionName: `main:${collectionName}`,
            data: { id: 17, amountA: 18 },
            status: APPROVAL_STATUS.SUBMITTED,
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
      db: {
        sequelize,
        getRepository: vi.fn(() => approvalRepository),
      },
      tego: {
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: vi.fn(() => ({
                    filterTargetKey: 'id',
                    options: {},
                    repository: { update: businessUpdate },
                    model: { associations: {}, primaryKeyAttributes: ['id'], sequelize },
                    fields: [],
                  })),
                },
              },
            ],
          ]),
        },
      },
      state: {
        currentTenant: { id: 'tenant-a' },
        currentTenantId: 'tenant-a',
        currentRole: 'root',
      },
      throw(errorStatus: number) {
        const error: any = new Error(`HTTP ${errorStatus}`);
        error.status = errorStatus;
        throw error;
      },
    };

    await expect(approvalActions.update(ctx, vi.fn())).rejects.toMatchObject({ status: 404 });
    expect(sequelize.transaction).toHaveBeenCalledOnce();
    expect(businessUpdate).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
    expect(approvalUpdate).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['missing business primary key', { amountA: 999 }, 400],
    ['business record outside current tenant', { id: 'business-b', amountA: 999 }, 404],
  ])('rejects approval update for %s before mutating approval state', async (_caseName, data, status) => {
    const businessUpdate = vi.fn().mockResolvedValue([]);
    const approvalUpdate = vi.fn();
    const ctx: any = {
      action: {
        resourceName: 'approvals',
        params: {
          filterByTk: 'approval-a',
          values: {
            collectionName: `main:${collectionName}`,
            data,
            status: APPROVAL_STATUS.SUBMITTED,
          },
        },
        mergeParams: vi.fn(),
      },
      db: {
        getRepository: vi.fn((name) =>
          name === 'approvals'
            ? {
                findOne: vi.fn().mockResolvedValue({
                  id: 'approval-a',
                  collectionName: `main:${collectionName}`,
                  dataKey: 'business-b',
                  data: { id: 'business-b' },
                }),
                update: approvalUpdate,
              }
            : undefined,
        ),
      },
      tego: {
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: () => ({
                    filterTargetKey: 'id',
                    options: { tenancy: 'tenantScoped' },
                    repository: { update: businessUpdate },
                    model: { associations: {} },
                    fields: [],
                  }),
                },
              },
            ],
          ]),
        },
      },
      state: {
        currentTenant: { id: 'tenant-a' },
        currentTenantId: 'tenant-a',
        currentRole: 'root',
      },
      transaction: { id: 'approval-transaction' },
      throw(errorStatus: number) {
        const error: any = new Error(`HTTP ${errorStatus}`);
        error.status = errorStatus;
        throw error;
      },
    };

    await expect(approvalActions.update(ctx, vi.fn())).rejects.toMatchObject({ status });
    if (data.id === undefined) {
      expect(businessUpdate).not.toHaveBeenCalled();
    } else {
      expect(businessUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          filterByTk: data.id,
          filter: { tenantId: 'tenant-a' },
          context: ctx,
          transaction: ctx.transaction,
        }),
      );
    }
    expect(approvalUpdate).not.toHaveBeenCalled();
  });
});
