import { applyTenantFilterToContext } from '@tachybase/module-tenant';
import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/module-workflow';
import { actions, parseCollectionName, traverseJSON, utils } from '@tego/server';

import { NAMESPACE } from '../../common/constants';
import { APPROVAL_STATUS } from '../constants/status';
import { cleanCopyAssociationData, CopyAssociationError } from '../copy-associations';
import {
  deferUntilTransactionCommitSucceeds,
  runDeferredAfterCommitCallbacks,
  type DeferredAfterCommit,
} from '../defer-after-commit';
import { withCurrentTenantFilter } from '../helpers/tenant-filter';
import { getSummary, getWorkflowAppends, serializeError } from '../tools';

const APPROVAL_COMMIT_UNCERTAIN_MESSAGE =
  'Approval commit outcome is uncertain; the external business record was retained';
const APPROVAL_DEFER_ERROR = 'Failed to defer workflow trigger until approval transaction commit';
const COMMIT_CLEANUP_ERROR = 'Business commit outcome is uncertain and transaction cleanup failed';
const DEFER_ERROR = 'Failed to defer workflow trigger until inherited approval transaction commit';
const ROLLBACK_MESSAGE = 'Approval outcome is uncertain after inherited transaction rollback';

function getRecordValue(record: any, key: string) {
  return record?.get?.(key) ?? record?.[key];
}

function getApprovalTargetKeys(collection: any): string | string[] | undefined {
  const filterTargetKey = collection?.filterTargetKey;
  if (filterTargetKey) {
    return filterTargetKey;
  }

  const primaryKeyAttributes = collection?.model?.primaryKeyAttributes;
  if (primaryKeyAttributes?.length === 1) {
    return primaryKeyAttributes[0];
  }
  return primaryKeyAttributes?.length ? primaryKeyAttributes : undefined;
}

function getApprovalUpdateTargetKey(data: any, filterTargetKey?: string | string[]) {
  if (!filterTargetKey || (Array.isArray(filterTargetKey) && filterTargetKey.length === 0)) {
    return undefined;
  }

  const targetKeys = Array.isArray(filterTargetKey) ? filterTargetKey : [filterTargetKey];
  if (
    targetKeys.some((key) => {
      const value = data?.[key];
      return value === undefined || value === null || value === '';
    })
  ) {
    return undefined;
  }

  if (Array.isArray(filterTargetKey)) {
    return Object.fromEntries(targetKeys.map((key) => [key, data[key]]));
  }

  return data?.[filterTargetKey];
}

function parsePersistedTargetKey(dataKey: unknown) {
  if (typeof dataKey !== 'string') {
    return dataKey;
  }

  try {
    return JSON.parse(dataKey);
  } catch {
    return dataKey;
  }
}

function getPersistedApprovalTargetKey(approval: any, targetKeys: string | string[]) {
  const dataKey = getRecordValue(approval, 'dataKey');
  if (!Array.isArray(targetKeys)) {
    if (dataKey !== undefined && dataKey !== null && dataKey !== '') {
      return dataKey;
    }
    return getRecordValue(approval, 'data')?.[targetKeys];
  }

  const parsedDataKey = parsePersistedTargetKey(dataKey);
  if (parsedDataKey && typeof parsedDataKey === 'object' && !Array.isArray(parsedDataKey)) {
    return parsedDataKey;
  }

  const persistedData = getRecordValue(approval, 'data');
  if (persistedData && typeof persistedData === 'object') {
    return Object.fromEntries(targetKeys.map((key) => [key, persistedData[key]]));
  }
}

function matchesApprovalTarget(approval: any, targetKey: unknown, targetKeys: string | string[]) {
  const persistedTargetKey = getPersistedApprovalTargetKey(approval, targetKeys);
  if (persistedTargetKey === undefined || persistedTargetKey === null || persistedTargetKey === '') {
    return false;
  }

  if (Array.isArray(targetKeys)) {
    return targetKeys.every(
      (key) =>
        targetKey?.[key] !== undefined &&
        targetKey?.[key] !== null &&
        `${targetKey[key]}` === `${persistedTargetKey?.[key]}`,
    );
  }

  return `${targetKey}` === `${persistedTargetKey}`;
}

async function createApprovalRecord(ctx, options) {
  const { values, transaction, dataSourceTransaction, deferAfterCommit } = options;
  const { whitelist, blacklist, updateAssociationValues } = ctx.action.params;
  return ctx.db.getRepository('approvals').create({
    values,
    whitelist,
    blacklist,
    updateAssociationValues,
    context: ctx,
    transaction,
    dataSourceTransaction,
    deferAfterCommit,
  });
}

async function updateApprovalRecord(ctx, transaction) {
  const { filterByTk, values, whitelist, blacklist, filter, updateAssociationValues, forceUpdate, targetCollection } =
    ctx.action.params;
  return utils.getRepositoryFromParams(ctx).update({
    filterByTk,
    values,
    whitelist,
    blacklist,
    filter,
    updateAssociationValues,
    forceUpdate,
    targetCollection,
    context: ctx,
    transaction,
  });
}

function requireUpdatedRecord(ctx: any, result: any) {
  if (!result || (Array.isArray(result) && result.length === 0)) {
    return ctx.throw(404);
  }

  return result;
}

function getApprovalTransaction(ctx: any) {
  const transaction = ctx.transaction;
  const approvalSequelize = ctx.db?.sequelize;
  if (approvalSequelize && transaction?.sequelize && transaction.sequelize !== approvalSequelize) {
    return undefined;
  }

  return transaction;
}

type DeferredWorkflowTrigger = DeferredAfterCommit;
type CreatedBusinessRecord = { persistedData: any; dataKey: unknown };
type CreateBusinessRecord = (transaction?: any) => Promise<CreatedBusinessRecord>;
type CreateApproval = (
  businessRecord: CreatedBusinessRecord,
  transaction?: any,
  sourceTransaction?: any,
) => Promise<any>;
type ReportDeferredWorkflowTriggerError = (dataKey: unknown) => (error: unknown) => void;

type ApprovalCreationPathOptions = {
  approvalSequelize: any;
  collectionName: string;
  createApproval: CreateApproval;
  createBusinessRecord: CreateBusinessRecord;
  ctx: any;
  deferredWorkflowTriggers: DeferredWorkflowTrigger[];
  reportDeferredWorkflowTriggerError: ReportDeferredWorkflowTriggerError;
};

type CrossSequelizeCreationOptions = ApprovalCreationPathOptions & {
  businessSequelize: any;
};

async function rollbackTransactions(ctx, pendingTransactions, originalError, dataKey) {
  const errors = [originalError];
  for (const { name, transaction } of pendingTransactions) {
    if (!transaction) {
      continue;
    }
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      errors.push(rollbackError);
      let forceCleanupError;
      try {
        await transaction.forceCleanup();
      } catch (error) {
        forceCleanupError = error;
        errors.push(error);
      }
      ctx.logger?.error?.('Transaction rollback outcome is uncertain', {
        dataKey,
        transaction: name,
        error: serializeError(rollbackError),
        forceCleanupError: forceCleanupError ? serializeError(forceCleanupError) : undefined,
      });
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Approval creation and transaction rollback failed for business record ${dataKey}`,
    );
  }
}

async function createWithSharedSequelize(options: ApprovalCreationPathOptions) {
  const {
    approvalSequelize,
    collectionName,
    createApproval,
    createBusinessRecord,
    ctx,
    deferredWorkflowTriggers,
    reportDeferredWorkflowTriggerError,
  } = options;
  const usesApprovalTransaction = ctx.transaction?.sequelize === approvalSequelize;
  let businessDataKey: unknown;
  const createInTransaction = async (transaction) => {
    const businessRecord = await createBusinessRecord(transaction);
    businessDataKey = businessRecord.dataKey;
    return createApproval(businessRecord, transaction);
  };
  const approval = usesApprovalTransaction
    ? await createInTransaction(ctx.transaction)
    : await approvalSequelize.transaction(createInTransaction);

  if (usesApprovalTransaction) {
    try {
      deferUntilTransactionCommitSucceeds(
        ctx.transaction,
        deferredWorkflowTriggers,
        reportDeferredWorkflowTriggerError(businessDataKey),
      );
    } catch (error) {
      ctx.logger?.error?.(APPROVAL_DEFER_ERROR, {
        dataKey: businessDataKey,
        collectionName,
        error: serializeError(error),
      });
      throw error;
    }
  } else {
    await runDeferredAfterCommitCallbacks(
      deferredWorkflowTriggers,
      reportDeferredWorkflowTriggerError(businessDataKey),
    );
  }

  return approval;
}

async function createAcrossSequelize(options: CrossSequelizeCreationOptions) {
  const {
    approvalSequelize,
    businessSequelize,
    collectionName,
    createApproval,
    createBusinessRecord,
    ctx,
    deferredWorkflowTriggers,
    reportDeferredWorkflowTriggerError,
  } = options;
  const usesApprovalTransaction = ctx.transaction?.sequelize === approvalSequelize;
  const inheritedApprovalTransaction = usesApprovalTransaction ? ctx.transaction : undefined;
  let approvalTransaction = inheritedApprovalTransaction;
  let businessTransaction;
  let businessRecord: CreatedBusinessRecord;
  let approval;
  const ownsApprovalTransaction = !inheritedApprovalTransaction;
  const getOwnedApprovalTransaction = () => {
    return ownsApprovalTransaction ? approvalTransaction : undefined;
  };

  try {
    if (ownsApprovalTransaction) {
      approvalTransaction = await approvalSequelize.transaction();
    }
    businessTransaction = await businessSequelize.transaction();
    businessRecord = await createBusinessRecord(businessTransaction);
    approval = await createApproval(businessRecord, approvalTransaction, businessTransaction);
  } catch (error) {
    await rollbackTransactions(
      ctx,
      [
        { name: 'approval', transaction: getOwnedApprovalTransaction() },
        { name: 'business', transaction: businessTransaction },
      ],
      error,
      businessRecord?.dataKey,
    );
    throw error;
  }

  try {
    await businessTransaction.commit();
    businessTransaction = undefined;
  } catch (error) {
    businessTransaction = undefined;
    try {
      // Sequelize commit() force-cleans connections when the commit outcome is uncertain.
      await rollbackTransactions(
        ctx,
        [{ name: 'approval', transaction: getOwnedApprovalTransaction() }],
        error,
        businessRecord.dataKey,
      );
    } catch (rollbackError) {
      ctx.logger?.error?.(COMMIT_CLEANUP_ERROR, {
        dataKey: businessRecord.dataKey,
        error: serializeError(error),
        rollbackError: serializeError(rollbackError),
      });
      throw rollbackError;
    }
    ctx.logger?.error?.(
      ownsApprovalTransaction
        ? 'Business commit outcome is uncertain; approval transaction was rolled back'
        : 'Business commit outcome is uncertain; inherited approval transaction was left open',
      {
        dataKey: businessRecord.dataKey,
        error: serializeError(error),
      },
    );
    throw error;
  }

  if (ownsApprovalTransaction) {
    try {
      await approvalTransaction.commit();
      approvalTransaction = undefined;
    } catch (error) {
      ctx.logger?.error?.(APPROVAL_COMMIT_UNCERTAIN_MESSAGE, {
        dataKey: businessRecord.dataKey,
        approvalId: approval?.id,
        error: serializeError(error),
      });
      throw error;
    }
    await runDeferredAfterCommitCallbacks(
      deferredWorkflowTriggers,
      reportDeferredWorkflowTriggerError(businessRecord.dataKey),
    );
  } else {
    try {
      deferUntilTransactionCommitSucceeds(
        approvalTransaction,
        deferredWorkflowTriggers,
        reportDeferredWorkflowTriggerError(businessRecord.dataKey),
        () => {
          ctx.logger?.error?.(ROLLBACK_MESSAGE, {
            dataKey: businessRecord.dataKey,
            collectionName,
          });
        },
      );
    } catch (error) {
      ctx.logger?.error?.(DEFER_ERROR, {
        dataKey: businessRecord.dataKey,
        collectionName,
        error: serializeError(error),
      });
      throw error;
    }
  }

  return approval;
}

/**
 * Handles the approvals resource action.
 */
export const approvals = {
  async create(ctx, next) {
    const { status, collectionName, data, workflowId, workflowKey, isCopy, copyAssociationValues } =
      ctx.action.params.values ?? {};
    const [dataSourceName, cName] = parseCollectionName(collectionName);
    const dataSource = ctx.tego.dataSourceManager.dataSources.get(dataSourceName);
    if (!dataSource) {
      return ctx.throw(400, `Data source "${dataSourceName}" not found`);
    }
    const collection = dataSource.collectionManager.getCollection(cName);
    if (!collection) {
      return ctx.throw(400, `Collection "${cName}" not found`);
    }

    // workflowKey selects the workflow; isCopy is the explicit copy protocol flag.
    let workflow;
    if (workflowKey) {
      workflow = await ctx.db.getRepository('workflows').findOne({
        filter: {
          key: workflowKey,
          enabled: true,
        },
      });
    } else {
      workflow = await ctx.db.getRepository('workflows').findOne({
        filterByTk: workflowId,
      });
    }

    /**
     * THINK:
     * 前端传来 workflow 的信息
     * 后端根据传来 workflow 的信息, 判断同 key 的是否有处于 enabled 状态的 workflow,
     * 有的话继续, 没的话中断
     * 并且因为处于 enabled 状态的 workflow, 如果有的话必然有且只有一个.
     * 那么新建的工作流, 应该根据这个处于启用状态的工作流的配置去创建.
     * 现有的逻辑是简单直接的, 默认前端传过来的必然是那个唯一的启用状态的配置, 不合适, 需要调整.
     */

    if (!workflow) {
      return ctx.throw(400, 'Current workflow not found or disabled, please refresh and try again');
    }

    if (status !== APPROVAL_STATUS.DRAFT) {
      ctx.action.mergeParams({
        values: {
          status: APPROVAL_STATUS.SUBMITTED,
        },
      });
    }
    const { repository, model } = collection;
    const deferredWorkflowTriggers: DeferredWorkflowTrigger[] = [];
    const deferAfterCommit = (callback: DeferredWorkflowTrigger) => {
      deferredWorkflowTriggers.push(callback);
    };
    let createData = traverseJSON(data, { collection });
    if (isCopy === true) {
      try {
        const copyPaths = copyAssociationValues;
        createData = cleanCopyAssociationData(data, createData, collection, copyPaths, ctx.tego);
      } catch (error) {
        if (error instanceof CopyAssociationError) {
          return ctx.throw(400, error.message);
        }
        throw error;
      }
    }
    const createBusinessRecord = async (transaction?) => {
      const values = await repository.create({
        values: {
          ...createData,
          createdBy: ctx.state.currentUser.id,
          updatedBy: ctx.state.currentUser.id,
        },
        context: ctx,
        transaction,
      });
      const createdDataKey = values.get(collection.filterTargetKey);
      if (createdDataKey == null || createdDataKey === '') {
        return ctx.throw(500, 'Created approval data is missing its target key');
      }
      const persistedRecord = await repository.findOne({
        filterByTk: createdDataKey,
        appends: getWorkflowAppends(workflow.config, collection, ctx.tego),
        context: ctx,
        transaction,
      });
      if (!persistedRecord) {
        return ctx.throw(500, 'Created approval data could not be reloaded');
      }
      const persistedData = { ...(persistedRecord.toJSON?.() ?? persistedRecord) };
      const dataKey = persistedData[collection.filterTargetKey];
      if (dataKey == null) {
        return ctx.throw(500, 'Reloaded approval data is missing its target key');
      }
      return { persistedData, dataKey };
    };

    const createApproval = async ({ persistedData, dataKey }, transaction?, sourceTransaction?) => {
      const summary = getSummary({
        summaryConfig: workflow.config.summary,
        data: persistedData,
        collection,
        app: ctx.tego,
      });
      const approvalData = { ...persistedData };
      Object.keys(model.associations).forEach((key) => {
        delete approvalData[key];
      });
      const approvalParams = { ...ctx.action.params.values };
      delete approvalParams.isCopy;
      delete approvalParams.copyAssociationValues;
      const approvalValues = {
        ...approvalParams,
        collectionName,
        data: approvalData,
        dataKey,
        workflowKey: workflow.key,
        workflowId: workflow.id,
        applicantRoleName: ctx.state.currentRole,
        summary,
      };
      ctx.action.mergeParams({ values: approvalValues }, { values: 'overwrite' });
      return createApprovalRecord(ctx, {
        values: approvalValues,
        transaction,
        dataSourceTransaction: sourceTransaction,
        deferAfterCommit,
      });
    };

    const reportDeferredWorkflowTriggerError = (dataKey: unknown) => (error: unknown) => {
      ctx.logger?.error?.('Deferred workflow trigger failed after approval commit', {
        dataKey,
        collectionName,
        error: serializeError(error),
      });
    };

    const approvalSequelize = ctx.db.sequelize;
    const creationOptions = {
      approvalSequelize,
      collectionName,
      createApproval,
      createBusinessRecord,
      ctx,
      deferredWorkflowTriggers,
      reportDeferredWorkflowTriggerError,
    };
    const approval =
      model.sequelize === approvalSequelize
        ? await createWithSharedSequelize(creationOptions)
        : await createAcrossSequelize({ ...creationOptions, businessSequelize: model.sequelize });

    ctx.body = approval;
    await next();
  },
  async update(ctx, next) {
    const { collectionName, data, status, updateAssociationValues, summaryConfig } = ctx.action.params.values ?? {};
    const approvalTransaction = getApprovalTransaction(ctx);
    const approval = await utils.getRepositoryFromParams(ctx).findOne({
      filterByTk: ctx.action.params.filterByTk,
      filter: withCurrentTenantFilter(ctx),
      context: ctx,
      transaction: approvalTransaction,
    });
    if (!approval) {
      return ctx.throw(404);
    }

    const persistedCollectionName = getRecordValue(approval, 'collectionName');
    if (typeof collectionName !== 'string' || typeof persistedCollectionName !== 'string') {
      return ctx.throw(400);
    }

    const [requestedDataSourceName, requestedCollectionName] = parseCollectionName(collectionName);
    const [persistedDataSourceName, persistedCollectionNameOnly] = parseCollectionName(persistedCollectionName);
    if (
      requestedDataSourceName !== persistedDataSourceName ||
      requestedCollectionName !== persistedCollectionNameOnly
    ) {
      return ctx.throw(400);
    }

    const dataSource = ctx.tego.dataSourceManager.dataSources.get(persistedDataSourceName);
    if (!dataSource) {
      return ctx.throw(400, `Data source "${persistedDataSourceName}" not found`);
    }
    const collection = dataSource.collectionManager.getCollection(persistedCollectionNameOnly);
    if (!collection) {
      return ctx.throw(400, `Collection "${persistedCollectionNameOnly}" not found`);
    }

    const targetKeys = getApprovalTargetKeys(collection);
    if (!targetKeys) {
      return ctx.throw(400);
    }
    const targetKey = getApprovalUpdateTargetKey(data, targetKeys);
    if (targetKey === undefined || !matchesApprovalTarget(approval, targetKey, targetKeys)) {
      return ctx.throw(400);
    }

    const updateBusinessRecord = async (transaction?) => {
      const updateOptions = applyTenantFilterToContext({ state: ctx.state }, collection, 'update', {
        filterByTk: targetKey,
        values: data,
        updateAssociationValues,
        context: ctx,
        transaction,
      });
      const [target] = await collection.repository.update(updateOptions);
      if (!target) {
        return ctx.throw(404);
      }
      return target;
    };

    const prepareApprovalUpdate = () => {
      const summary = getSummary({
        summaryConfig,
        data: data,
        collection,
        app: ctx.tego,
      });

      ctx.action.mergeParams({
        values: {
          collectionName: persistedCollectionName,
          dataKey: getRecordValue(approval, 'dataKey'),
          status: status ?? APPROVAL_STATUS.SUBMITTED,
          data: data,
          applicantRoleName: ctx.state.currentRole,
          summary,
        },
      });
    };

    const updateBusinessAndApproval = async (transaction?) => {
      await updateBusinessRecord(transaction);
      prepareApprovalUpdate();
      return requireUpdatedRecord(ctx, await updateApprovalRecord(ctx, transaction));
    };

    const approvalSequelize = ctx.db.sequelize;
    const businessSequelize = collection.model?.sequelize;
    if (approvalSequelize && businessSequelize === approvalSequelize) {
      const inheritedTransaction = ctx.transaction?.sequelize === approvalSequelize ? ctx.transaction : undefined;
      ctx.body = inheritedTransaction
        ? await updateBusinessAndApproval(inheritedTransaction)
        : await approvalSequelize.transaction(updateBusinessAndApproval);
      ctx.status = 200;
      await next();
      return;
    }

    // Separate data sources cannot share a Sequelize transaction, so retain the sequential update path.
    const businessTransaction = ctx.transaction?.sequelize === businessSequelize ? ctx.transaction : undefined;
    await updateBusinessRecord(businessTransaction);
    prepareApprovalUpdate();
    const updatedApproval = requireUpdatedRecord(ctx, await updateApprovalRecord(ctx, approvalTransaction));
    ctx.body = updatedApproval;
    ctx.status = 200;
    await next();
  },
  async destroy(ctx, next) {
    const {
      filterByTk,
      values: { status },
    } = ctx.action.params ?? {};
    if (status !== APPROVAL_STATUS.DRAFT) {
      return ctx.throw(400);
    }
    const repository = utils.getRepositoryFromParams(ctx);
    const approval = await repository.findOne({
      filterByTk,
      filter: withCurrentTenantFilter(ctx, {
        createdById: ctx.state.currentUser.id,
      }),
    });
    if (!approval) {
      return ctx.throw(404);
    }
    return actions.destroy(ctx, next);
  },
  async withdraw(ctx, next) {
    const { filterByTk } = ctx.action.params;
    const repository = utils.getRepositoryFromParams(ctx);
    const approval = await repository.findOne({
      filterByTk,
      filter: withCurrentTenantFilter(ctx),
      appends: ['workflow'],
      except: ['workflow.options'],
    });
    if (!approval) {
      return ctx.throw(404);
    }
    if (approval.createdById !== ctx.state.currentUser?.id) {
      return ctx.throw(403);
    }
    if (approval.status !== APPROVAL_STATUS.SUBMITTED || !approval.workflow.config.withdrawable) {
      return ctx.throw(400);
    }
    const [execution] = await approval.getExecutions({
      where: {
        status: EXECUTION_STATUS.STARTED,
      },
      limit: 1,
    });

    if (!execution) {
      return ctx.throw(404, 'Execution not found! Please contact the administrator.');
    }

    // 如果当前 workflow 未启用，则查找同 workflowKey 且 enable 为 true 的最新 workflow，并挂到 approval 上，同时存到数据库
    if (!approval.workflow.enabled && approval.workflow?.key) {
      const latestWorkflow = await ctx.db.getRepository('workflows').findOne({
        filter: {
          key: approval.workflow.key,
          enabled: true,
        },
        order: [['updatedAt', 'DESC']],
      });
      if (latestWorkflow && approval.workflow.id !== latestWorkflow.id) {
        approval.workflow = latestWorkflow;
        await approval.update(
          {
            workflowId: latestWorkflow.id,
          },
          {
            transaction: ctx.transaction,
          },
        );
      }
    }

    execution.workflow = approval.workflow;
    await ctx.db.sequelize.transaction(async (transaction) => {
      const records = await approval.getRecords({
        where: {
          executionId: execution.id,
        },
        include: [
          {
            association: 'job',
            where: {
              status: JOB_STATUS.PENDING,
            },
            required: true,
          },
        ],
        transaction,
      });
      await ctx.db.getRepository('approvalRecords').destroy({
        filter: {
          id: records.map((record) => record.id),
        },
        transaction,
      });
      const jobsMap = records.reduce((map, record) => {
        if (!map.has(record.job.id)) {
          record.job.execution = execution;
          record.job.latestUserJob = record.get();
          record.job.latestUserJob.approval = approval;
          map.set(record.job.id, record.job);
        }
        return map;
      }, new Map());
      return Array.from(jobsMap.values());
    });
    ctx.body = approval;
    ctx.status = 202;
    await next();

    await execution.update({
      status: EXECUTION_STATUS.CANCELED,
    });
  },
  async listCentralized(ctx, next) {
    const centralizedApprovalFlow = await ctx.db.getRepository('workflows').find({
      filter: {
        type: 'approval',
        'config.centralized': true,
      },
      fields: ['id'],
    });

    ctx.action.mergeParams({
      filter: withCurrentTenantFilter(ctx, {
        workflowId: centralizedApprovalFlow.map((item) => item.id),
      }),
    });

    return await actions.list(ctx, next);
  },

  async reminder(ctx, next) {
    const { filterByTk } = ctx.action.params;
    const repository = utils.getRepositoryFromParams(ctx);
    const approval = await repository.findOne({
      filterByTk,
      filter: withCurrentTenantFilter(ctx),
      appends: ['records', 'workflow', 'createdBy.nickname'],
    });
    if (!approval) {
      return ctx.throw(404);
    }
    if (approval.createdById !== ctx.state.currentUser?.id) {
      return ctx.throw(403);
    }
    if ([APPROVAL_STATUS.APPROVED, APPROVAL_STATUS.REJECTED, APPROVAL_STATUS.ERROR].includes(approval.status)) {
      return ctx.throw(400);
    }

    if (approval.records?.length === 0) {
      return ctx.throw(400);
    }

    const assignees = approval.records.map((record) => record.userId);

    // 构造好审批数据后, 依次通知审批人审批
    for (const userId of assignees) {
      const [dataSourceName] = parseCollectionName(approval.collectionName);
      const collection = ctx.tego.dataSourceManager.dataSources
        .get(dataSourceName)
        .collectionManager.getCollection(approval.collectionName);
      const message = {
        userId,
        title: `{{t("Approval", { ns: '${NAMESPACE}' })}}`,
        content: `{{t("{{user}} reminder", { ns: "${NAMESPACE}", user: "${approval.createdBy.nickname}" })}}`,
        collectionName: approval.collectionName,
        jsonContent: approval.summary,
        schemaName: approval.workflow?.config.applyDetail,
        dataKey: approval.data[collection.filterTargetKey],
      };

      ctx.tego.messageManager.sendMessage(+userId, message);
    }

    await next();

    ctx.status = 200;
    ctx.body = {
      message: 'reminder sent',
      success: true,
    };
  },
};
