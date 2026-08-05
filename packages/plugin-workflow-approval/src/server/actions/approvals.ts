import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/module-workflow';
import { actions, parseCollectionName, traverseJSON, utils } from '@tego/server';

import { NAMESPACE } from '../../common/constants';
import { APPROVAL_STATUS } from '../constants/status';
import { cleanCopyAssociationData, CopyAssociationError } from '../copyAssociations';
import {
  deferUntilTransactionCommitSucceeds,
  runDeferredAfterCommitCallbacks,
  type DeferredAfterCommit,
} from '../deferAfterCommit';
import { getSummary, getWorkflowAppends } from '../tools';

async function createApprovalRecord(ctx, values, transaction, dataSourceTransaction, deferAfterCommit) {
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

type DeferredWorkflowTrigger = DeferredAfterCommit;

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (error && typeof error === 'object') {
    const errorRecord = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof errorRecord.name === 'string' ? errorRecord.name : undefined,
      message: typeof errorRecord.message === 'string' ? errorRecord.message : String(error),
      stack: typeof errorRecord.stack === 'string' ? errorRecord.stack : undefined,
    };
  }

  return { message: String(error) };
}

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
        await transaction.forceCleanup?.();
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
        createData = cleanCopyAssociationData(data, createData, collection, copyAssociationValues);
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

    const createApproval = async ({ persistedData, dataKey }, transaction?, dataSourceTransaction?) => {
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
      const approvalValues = {
        ...ctx.action.params.values,
        collectionName,
        data: approvalData,
        dataKey,
        workflowKey: workflow.key,
        workflowId: workflow.id,
        applicantRoleName: ctx.state.currentRole,
        summary,
      };
      ctx.action.mergeParams({ values: approvalValues }, { values: 'overwrite' });
      return createApprovalRecord(ctx, approvalValues, transaction, dataSourceTransaction, deferAfterCommit);
    };

    const businessSequelize = model.sequelize;
    const approvalSequelize = ctx.db.sequelize;
    let approval;
    if (businessSequelize === approvalSequelize) {
      const createInTransaction = async (transaction) => {
        const businessRecord = await createBusinessRecord(transaction);
        return createApproval(businessRecord, transaction);
      };
      approval =
        ctx.transaction?.sequelize === approvalSequelize
          ? await createInTransaction(ctx.transaction)
          : await approvalSequelize.transaction(createInTransaction);
      if (ctx.transaction?.sequelize === approvalSequelize) {
        deferUntilTransactionCommitSucceeds(ctx.transaction, deferredWorkflowTriggers);
      } else {
        await runDeferredAfterCommitCallbacks(deferredWorkflowTriggers);
      }
    } else {
      const inheritedApprovalTransaction =
        ctx.transaction?.sequelize === approvalSequelize ? ctx.transaction : undefined;
      let approvalTransaction = inheritedApprovalTransaction;
      let businessTransaction;
      let businessRecord;
      const ownsApprovalTransaction = !inheritedApprovalTransaction;
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
            { name: 'approval', transaction: ownsApprovalTransaction ? approvalTransaction : undefined },
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
        const failedBusinessTransaction = businessTransaction;
        businessTransaction = undefined;
        try {
          await rollbackTransactions(
            ctx,
            [
              { name: 'approval', transaction: ownsApprovalTransaction ? approvalTransaction : undefined },
              { name: 'business', transaction: failedBusinessTransaction },
            ],
            error,
            businessRecord.dataKey,
          );
        } catch (rollbackError) {
          ctx.logger?.error?.('Business commit outcome is uncertain and transaction cleanup failed', {
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
          ctx.logger?.error?.('Approval commit outcome is uncertain; the external business record was retained', {
            dataKey: businessRecord.dataKey,
            approvalId: approval?.id,
            error: serializeError(error),
          });
          throw error;
        }
        await runDeferredAfterCommitCallbacks(deferredWorkflowTriggers);
      } else {
        deferUntilTransactionCommitSucceeds(approvalTransaction, deferredWorkflowTriggers);
      }
    }

    ctx.body = approval;
    await next();
  },
  async update(ctx, next) {
    const { collectionName, data, status, updateAssociationValues, summaryConfig } = ctx.action.params.values ?? {};
    const [dataSourceName, cName] = parseCollectionName(collectionName);
    const dataSource = ctx.tego.dataSourceManager.dataSources.get(dataSourceName);
    const collection = dataSource.collectionManager.getCollection(cName);

    const [target] = await collection.repository.update({
      filterByTk: data[collection.filterTargetKey],
      values: data,
      updateAssociationValues,
    });

    const summary = getSummary({
      summaryConfig,
      data: data,
      collection,
      app: ctx.tego,
    });

    ctx.action.mergeParams({
      values: {
        status: status ?? APPROVAL_STATUS.SUBMITTED,
        data: data,
        applicantRoleName: ctx.state.currentRole,
        summary,
      },
    });
    return actions.update(ctx, next);
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
      filter: {
        createdById: ctx.state.currentUser.id,
      },
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
      filter: {
        workflowId: centralizedApprovalFlow.map((item) => item.id),
      },
    });

    return await actions.list(ctx, next);
  },

  async reminder(ctx, next) {
    const { filterByTk } = ctx.action.params;
    const repository = utils.getRepositoryFromParams(ctx);
    const approval = await repository.findOne({
      filterByTk,
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
