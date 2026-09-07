import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/module-workflow';
import { getApp, waitForWorkflowIdle } from '@tachybase/plugin-workflow-test';
import { mockDatabase, SequelizeDataSource } from '@tego/server';

import { registerLegacyTenantClaimGuard } from '../../../../module-tenant/src/server/helpers/legacy-data-claim';
import approvalExecutions from '../collections/approvalExecutions';
import approvalRecords from '../collections/approvalRecords';
import approvals from '../collections/approvals';
import { APPROVAL_ACTION_STATUS, APPROVAL_STATUS } from '../constants/status';
import ApprovalInstruction from '../instructions/Approval';
import ApprovalTrigger from '../triggers/Approval';

describe('legacy approval tenant recovery', () => {
  let app;
  let db;
  let plugin;
  let trigger;
  let collection;
  let externalDatabase;

  beforeAll(async () => {
    app = await getApp();
    db = app.db;
    plugin = app.pm.get('workflow');
    registerLegacyTenantClaimGuard(db);
    Object.assign(db.getCollection('executions').options, {
      tenancy: 'tenantInherited',
      allowEditingLegacyData: true,
      legacyDataTenantIds: ['owner'],
    });
    db.collection(approvalExecutions);
    db.collection(approvalRecords);
    db.collection(approvals);
    db.collection({
      name: 'tenants',
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
        { name: 'path', type: 'string' },
        { name: 'parentId', type: 'string' },
      ],
    });
    collection = db.collection({
      name: 'legacyApprovalReceipts',
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'status', type: 'string' },
      ],
    });
    await db.sync();
    await db.getRepository('tenants').create({
      values: [
        { id: 'owner', enabled: true, path: '/owner/' },
        { id: 'child', enabled: true, path: '/owner/child/' },
        { id: 'other', enabled: true, path: '/other/' },
        { id: 'disabled', enabled: false, path: '/disabled/' },
      ],
    });
    trigger = new ApprovalTrigger(plugin);
    plugin.triggers.register('approval', trigger);
    plugin.instructions.register('approval', new ApprovalInstruction(plugin));
  });

  afterAll(async () => {
    await waitForWorkflowIdle(app);
    await externalDatabase?.close();
    await app.destroy();
  });

  async function createPendingApproval(tenancy = 'tenantInherited', owner: string | null = 'owner') {
    // The execution predates tenant activation; only the business record has since acquired an owner.
    collection.options.tenancy = tenancy;
    collection.options.legacyDataTenantIds = ['owner'];
    collection.options.allowEditingLegacyData = true;
    const receipt = await collection.model.create({ tenantId: owner, status: 'pending' });
    const workflow = await db.getModel('workflows').create({
      type: 'approval',
      enabled: false,
      config: { collection: collection.name },
    });
    const node = await workflow.createNode({
      type: 'approval',
      config: { branchMode: true, assignees: [], negotiation: 0 },
    });
    await workflow.createNode({
      type: 'update',
      upstreamId: node.id,
      branchIndex: APPROVAL_ACTION_STATUS.APPROVED,
      config: {
        collection: collection.name,
        params: {
          filter: { id: '{{$context.data.id}}' },
          values: { status: 'completed' },
          individualHooks: true,
        },
      },
    });
    const approval = await db
      .getModel('approvals')
      .create(
        { workflowId: workflow.id, collectionName: collection.name, dataKey: String(receipt.id), status: 2 },
        { hooks: false },
      );
    const execution = await db.getModel('executions').create(
      {
        workflowId: workflow.id,
        status: EXECUTION_STATUS.STARTED,
        context: { approvalId: approval.id, collectionName: collection.name, data: { id: receipt.id } },
      },
      { hooks: false },
    );
    await db.getModel('approvalExecutions').create({ approvalId: approval.id, executionId: execution.id });
    const job = await db.getModel('jobs').create({
      executionId: execution.id,
      nodeId: node.id,
      nodeKey: node.key,
      status: JOB_STATUS.PENDING,
    });
    await db.getModel('approvalRecords').create({
      approvalId: approval.id,
      executionId: execution.id,
      jobId: job.id,
      status: APPROVAL_ACTION_STATUS.APPROVED,
    });
    job.latestUserJob = { approval };
    return { approval, receipt, execution, job };
  }

  it.each([
    ['tenantScoped', {}],
    ['tenantInherited', {}],
    ['tenantScoped', { currentTenantId: 'other', currentRole: 'member', currentUserId: 42 }],
  ])(
    'resumes a pre-tenant approval using the record owner in %s mode with request state %j',
    async (mode: string, state) => {
      const { approval, receipt, execution, job } = await createPendingApproval(mode);
      const processor = plugin.createProcessor(execution, {
        httpContext: { state },
      });

      await processor.resume(job);

      await receipt.reload();
      await execution.reload();
      await approval.reload();
      expect(receipt.status).toBe('completed');
      expect(receipt.tenantId).toBe('owner');
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(approval.status).toBe(APPROVAL_STATUS.APPROVED);
      expect(execution.tenantId).toBe('owner');
      expect(execution.tenantContext).toMatchObject({
        currentTenantId: 'owner',
        currentTenant: { id: 'owner' },
        currentTenantDescendantIds: ['child'],
      });
      expect(execution.authContext).toBeNull();
      expect(plugin.createProcessor(execution).getRepositoryContext().state.currentTenantId).toBe('owner');
    },
  );

  it.each([null, 'disabled', 'deleted-tenant'])('rejects an unresolved or inactive owner: %s', async (owner) => {
    const { receipt, execution, job } = await createPendingApproval('tenantScoped', owner);
    await plugin.createProcessor(execution, { context: { state: { currentTenantId: 'other' } } }).resume(job);
    await receipt.reload();
    await execution.reload();
    expect(receipt.status).toBe('pending');
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(execution.tenantId).toBeNull();
    expect(execution.tenantContext).toBeNull();
    await job.reload();
    expect(job.result.message).toContain('The tenant for this legacy approval could not be determined.');
  });

  it('does not replace the tenant of an execution that already has context', async () => {
    const { receipt, execution, job } = await createPendingApproval('tenantScoped');
    await execution.update({ tenantId: 'other', tenantContext: { currentTenantId: 'other' } }, { hooks: false });
    await plugin.createProcessor(execution).resume(job);
    await receipt.reload();
    await execution.reload();
    expect(receipt.status).toBe('pending');
    expect(execution.tenantId).toBe('other');
    expect(execution.tenantContext).toEqual({ currentTenantId: 'other' });
  });

  it('keeps shared collections working without a tenant', async () => {
    const { receipt, execution, job } = await createPendingApproval('shared', null);
    await plugin.createProcessor(execution).resume(job);
    await receipt.reload();
    await execution.reload();
    expect(receipt.status).toBe('completed');
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(execution.tenantId).toBeNull();
  });

  it('rejects a deleted source record without adopting the browser tenant', async () => {
    const { receipt, execution, job } = await createPendingApproval();
    await receipt.destroy();
    await plugin.createProcessor(execution, { context: { state: { currentTenantId: 'other' } } }).resume(job);
    await execution.reload();
    expect(execution.status).toBe(EXECUTION_STATUS.ERROR);
    expect(execution.tenantId).toBeNull();
  });

  it('does not use the tenant in the historical business snapshot', async () => {
    const { receipt, execution, job } = await createPendingApproval();
    await execution.update(
      { context: { ...execution.context, data: { id: receipt.id, tenantId: 'other' } } },
      { hooks: false },
    );
    await plugin.createProcessor(execution).resume(job);
    await execution.reload();
    await receipt.reload();
    expect(execution.tenantId).toBe('owner');
    expect(receipt.status).toBe('completed');
  });

  it('requires a persisted binding to the approval rather than trusting context.approvalId', async () => {
    const { receipt, execution } = await createPendingApproval();
    await db.getRepository('approvalExecutions').destroy({ filter: { executionId: execution.id } });
    const processor = plugin.createProcessor(execution);
    await processor.prepare();
    await expect(trigger.prepareExecution(processor)).rejects.toThrow(
      'The tenant for this legacy approval could not be determined.',
    );
    await receipt.reload();
    await execution.reload();
    expect(receipt.status).toBe('pending');
    expect(execution.tenantContext).toBeNull();
  });

  it('rechecks a stale execution under lock and preserves context already saved by another worker', async () => {
    const { receipt, execution, job } = await createPendingApproval('tenantScoped');
    await db
      .getModel('executions')
      .update(
        { tenantId: 'other', tenantContext: { currentTenantId: 'other' } },
        { where: { id: execution.id }, hooks: false },
      );
    await plugin.createProcessor(execution).resume(job);
    await receipt.reload();
    await execution.reload();
    expect(receipt.status).toBe('pending');
    expect(execution.tenantId).toBe('other');
    expect(execution.tenantContext).toEqual({ currentTenantId: 'other' });
  });

  it('rolls back recovered metadata with the calling transaction', async () => {
    const { execution } = await createPendingApproval();
    await expect(
      db.sequelize.transaction(async (transaction) => {
        const processor = plugin.createProcessor(execution, { transaction });
        await processor.prepare();
        await trigger.prepareExecution(processor);
        const saved = await db.getModel('executions').findByPk(execution.id, { transaction });
        expect(saved.tenantId).toBe('owner');
        throw new Error('Rollback caller transaction');
      }),
    ).rejects.toThrow('Rollback caller transaction');
    await execution.reload();
    expect(execution.tenantId).toBeNull();
    expect(execution.tenantContext).toBeNull();
  });

  it('treats recovered tenant metadata as persisted when saving execution status', async () => {
    const { execution, job, receipt, approval } = await createPendingApproval();
    const processor = plugin.createProcessor(execution);
    await processor.prepare();
    await trigger.prepareExecution(processor);
    expect(execution.changed('tenantId')).toBe(false);
    expect(execution.changed('tenantContext')).toBe(false);
    await processor.resume(job);
    await execution.reload();
    await receipt.reload();
    await approval.reload();
    expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(receipt.status).toBe('completed');
    expect(approval.status).toBe(APPROVAL_STATUS.APPROVED);
  });

  it('reads ownership from the bound external data source without forwarding the main transaction', async () => {
    const { approval, execution } = await createPendingApproval();
    externalDatabase = mockDatabase({ storage: ':memory:', tablePrefix: 'legacy_approval_external_' });
    await app.dataSourceManager.add(
      new SequelizeDataSource({
        name: 'legacyExternal',
        collectionManager: { database: externalDatabase },
        resourceManager: {},
      }),
    );
    const externalCollection = externalDatabase.collection({
      name: collection.name,
      tenancy: 'tenantScoped',
      fields: [{ name: 'tenantId', type: 'string' }],
    });
    await externalDatabase.sync();
    const externalRecord = await externalCollection.model.create({ tenantId: 'child' });
    const qualifiedName = `legacyExternal:${collection.name}`;
    await approval.update({ collectionName: qualifiedName, dataKey: String(externalRecord.id) }, { hooks: false });
    await db
      .getModel('workflows')
      .update({ config: { collection: qualifiedName } }, { where: { id: execution.workflowId }, hooks: false });
    await db.sequelize.transaction(async (transaction) => {
      const processor = plugin.createProcessor(execution, { transaction });
      await processor.prepare();
      await trigger.prepareExecution(processor);
    });
    await execution.reload();
    expect(execution.tenantId).toBe('child');
    expect(execution.tenantContext.currentTenantId).toBe('child');
  });
});
