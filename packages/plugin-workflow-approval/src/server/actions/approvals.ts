import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/module-workflow';
import { actions, parseCollectionName, traverseJSON, utils } from '@tego/server';

import { NAMESPACE } from '../../common/constants';
import { APPROVAL_STATUS } from '../constants/status';
import { getSummary } from '../tools';

export const approvals = {
  async create(ctx, next) {
    const { status, collectionName, data, workflowId, workflowKey } = ctx.action.params.values ?? {};
    const [dataSourceName, cName] = parseCollectionName(collectionName);
    const dataSource = ctx.tego.dataSourceManager.dataSources.get(dataSourceName);
    if (!dataSource) {
      return ctx.throw(400, `Data source "${dataSourceName}" not found`);
    }
    const collection = dataSource.collectionManager.getCollection(cName);
    if (!collection) {
      return ctx.throw(400, `Collection "${cName}" not found`);
    }

    // 如果能拿到 key, 说明是复制操作, 否则是新建操作;
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
    // 如果是复制操作,要将repository的关联字段的 id 排除掉,以防认为是修改,而不是新建;
    // 背景是复制操作, 前端传过来的是一个完整的对象, 如果直接创建, 会导致关联字段的 id 被认为是已有数据, 从而认为是修改,而不是新建. 特别是多对多的字段.
    let dataToCreate = traverseJSON(data, { collection });
    if (workflowKey) {
      // 找出所有关联字段的 key（这些一般是 model.associations 的 key）
      // 遍历 model.associations，按 Sequelize 约定，关联 id 字段一般形如 xxxId 或 array 形
      Object.values(collection.model.associations || {}).forEach((assocUnknown) => {
        // 显式类型断言
        const assoc = assocUnknown as {
          foreignKey?: string;
          as?: string;
          associationType?: string;
          targetKey?: string;
          target?: { primaryKeyAttribute?: string; primaryKey?: string };
        };

        // 只处理属于本数据的外键字段
        if (assoc.foreignKey && Object.prototype.hasOwnProperty.call(dataToCreate, assoc.foreignKey)) {
          // 移除外键 id，避免被认为是已有数据
          delete dataToCreate[assoc.foreignKey];
        }
        // 处理 BelongsToMany（多对多），应删除的是 source 关联的 targetKey（目标表主键、如 targetId），而不是中间表的 id
        if (assoc.associationType === 'BelongsToMany' && assoc.as && Array.isArray(dataToCreate[assoc.as])) {
          // 这里 assoc.as 是关联在 dataToCreate 上的字段名（一般为模型名的复数，如 tags）
          // 将每个对象里的 target 主键 id 字段删除，目标字段通常是 targetKey 或 target主键，如 targetId 等
          const targetKey =
            assoc.targetKey && typeof assoc.targetKey === 'string'
              ? assoc.targetKey
              : // fallback: 一般为 target model 的主键
                assoc.target?.primaryKeyAttribute || assoc.target?.primaryKey || 'id';
          (dataToCreate[assoc.as] as Array<any>).forEach((item: any) => {
            if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, targetKey)) {
              delete item[targetKey];
            }
          });
        }
      });
    }

    const values = await repository.create({
      values: {
        ...dataToCreate,
        createdBy: ctx.state.currentUser.id,
        updatedBy: ctx.state.currentUser.id,
      },
      context: ctx,
    });
    const instance = values.get();
    const summary = getSummary({
      summaryConfig: workflow.config.summary,
      data: {
        ...instance,
        ...data,
      },
      collection,
      app: ctx.tego,
    });
    Object.keys(model.associations).forEach((key) => {
      delete instance[key];
    });
    ctx.action.mergeParams({
      values: {
        collectionName,
        data: instance,
        dataKey: values[collection.filterTargetKey],
        workflowKey: workflow.key,
        workflowId: workflow.id,
        applicantRoleName: ctx.state.currentRole,
        summary,
      },
    });
    return actions.create(ctx, next);
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
