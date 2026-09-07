import { getDescendantIds } from '@tachybase/module-tenant';
import type { Processor } from '@tachybase/module-workflow';
import { parseCollectionName } from '@tego/server';

const RECOVERY_FAILED =
  'The tenant for this legacy approval could not be determined. Ask an administrator to check the linked record and its tenant before trying again.';

function hasTenant(execution: any) {
  const context = execution.get('tenantContext');
  return execution.get('tenantId') != null || context?.currentTenantId != null || context?.currentTenant?.id != null;
}

/** Recover only from the persisted approval binding, never from a snapshot or the resuming user's tenant. */
export async function restoreLegacyApprovalTenant(processor: Processor) {
  const { execution, transaction } = processor;
  if (hasTenant(execution)) {
    return;
  }
  const { db, app } = processor.options.plugin;
  const fail = () => new Error(app.i18n.t(RECOVERY_FAILED, { ns: 'workflow-approval' }));
  const restore = async (transaction) => {
    const persisted = await db.getModel('executions').findByPk(execution.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!persisted) {
      throw fail();
    }
    if (hasTenant(persisted)) {
      return { tenantId: persisted.get('tenantId'), tenantContext: persisted.get('tenantContext') };
    }
    const binding = await db.getRepository('approvalExecutions').findOne({
      filter: { executionId: execution.id, approvalId: persisted.get('context')?.approvalId },
      appends: ['approval'],
      transaction,
    });
    const approval = binding?.get('approval');
    const collectionName = approval?.get('collectionName');
    if (!collectionName || collectionName !== execution.workflow.config.collection) {
      throw fail();
    }
    const [dataSourceName, name] = parseCollectionName(collectionName);
    const collection = app.dataSourceManager.dataSources.get(dataSourceName)?.collectionManager.getCollection(name);
    if (!collection) {
      throw fail();
    }
    if (!['tenantScoped', 'tenantInherited'].includes(collection.options.tenancy)) {
      return;
    }
    const dataKey = approval.get('dataKey');
    if (dataKey == null || dataKey === '') {
      throw fail();
    }
    // This ownership-only lookup is scoped to the server-owned approval binding, not caller-supplied filters.
    const record = await collection.repository.findOne({
      filterByTk: dataKey,
      fields: ['tenantId'],
      transaction: processor.options.plugin.useDataSourceTransaction(dataSourceName, transaction),
    });
    const tenantId = record?.get('tenantId');
    if (tenantId == null || tenantId === '' || !db.getCollection('tenants')) {
      throw fail();
    }
    if (approval.get('tenantId') != null && String(approval.get('tenantId')) !== String(tenantId)) {
      throw fail();
    }
    const tenants = db.getRepository('tenants');
    const tenant = await tenants.findOne({ filterByTk: tenantId, filter: { enabled: true }, transaction });
    if (!tenant) {
      throw fail();
    }
    const values = {
      tenantId,
      tenantContext: {
        currentTenant: { id: tenantId },
        currentTenantId: tenantId,
        currentTenantDescendantIds: await getDescendantIds(tenants, tenantId, { transaction }),
      },
    };
    // Metadata recovery must not trigger approval status hooks or business workflows.
    await persisted.update(values, { transaction, hooks: false });
    return values;
  };
  const values = transaction ? await restore(transaction) : await db.sequelize.transaction(restore);
  if (values) {
    execution.set(values);
  }
}
