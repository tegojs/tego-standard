import _ from 'lodash';

import Jobs from '../../collections/2-jobs';
import { JOB_STATUS } from '../../constants';
import Instruction from '../../instructions';
import Processor from '../../Processor';

export class TriggerInstruction extends Instruction {
  async run(node, input, processor: Processor) {
    const { workflowKey, sourceArray = [], model } = node.config;
    const wfRepo = this.workflow.db.getRepository('workflows');
    const wf = await wfRepo.findOne({ filter: { key: workflowKey, enabled: true } });

    if (!wf) {
      return {
        status: JOB_STATUS.FAILED,
        result: `Workflow with key "${workflowKey}" not found or disabled`,
      };
    }

    // 安全检查：检查子工作流是否包含危险的节点类型
    const dangerousNodeTypes = ['data-mapping', 'script', 'js-parse', 'json-parse'];
    const hasDangerousNodes = wf.nodes?.some((node) => dangerousNodeTypes.includes(node.type));

    if (hasDangerousNodes) {
      this.workflow
        .getLogger(wf.id)
        .warn(
          `Triggering workflow ${workflowKey} contains potentially dangerous nodes: ${dangerousNodeTypes.join(', ')}`,
        );
    }

    try {
      // 1. 处理数据输入：从 sourceArray 获取数据源
      let triggerData = input.result;
      if (sourceArray && sourceArray.length > 0) {
        let data = {};
        switch (sourceArray.length) {
          case 0: {
            // 无数据源,使用默认值
            data = {};
            break;
          }
          case 1: {
            // 单数据源, 平铺为单对象;
            const keyName = sourceArray[0]['keyName'];
            const sourcePath = sourceArray[0]['sourcePath'];
            const rawData = processor.getParsedValue(sourcePath, node.id);
            // NOTE: 如果提供了keyName 就是统一的用法, 如果没有, 就是平铺.
            if (keyName) {
              data = {
                [keyName]: rawData,
              };
            } else {
              data = rawData;
            }
            break;
          }
          default: {
            // 多个数据源, 进行合并
            data = sourceArray.reduce(
              (cookedData, { keyName, sourcePath }) => ({
                ...cookedData,
                [keyName]: processor.getParsedValue(sourcePath, node.id),
              }),
              {},
            );
          }
        }
        triggerData = data;
      }

      if (wf.sync) {
        const p = await this.workflow.trigger(wf, triggerData, processor.options);
        if (!p) {
          return {
            status: JOB_STATUS.FAILED,
            result: 'Failed to trigger sub-workflow',
          };
        }
        const { lastSavedJob } = p;

        // 检查子工作流执行结果
        if (lastSavedJob?.status === JOB_STATUS.ERROR) {
          return {
            status: JOB_STATUS.FAILED,
            result: `Sub-workflow execution failed: ${lastSavedJob.result}`,
          };
        }

        // 2. 处理数据输出：对结果进行字段映射
        let result = lastSavedJob?.result;
        if (typeof result === 'object' && result && model?.length) {
          if (Array.isArray(result)) {
            result = result.map((item) => this.mapModel(item, model));
          } else {
            result = this.mapModel(result, model);
          }
        }

        return {
          status: JOB_STATUS.RESOLVED,
          result,
        };
      } else {
        this.workflow.trigger(wf, triggerData, {
          ...processor.options,
          parentNode: node.id,
          parent: processor.execution,
        });
        return {
          status: JOB_STATUS.PENDING,
        };
      }
    } catch (error) {
      this.workflow.getLogger(wf.id).error(`Error triggering sub-workflow ${workflowKey}:`, error);
      return {
        status: JOB_STATUS.FAILED,
        result: `Sub-workflow trigger error: ${error.message}`,
      };
    }
  }

  /**
   * 将数据按照 model 配置进行字段映射
   */
  private mapModel(data, model) {
    if (typeof data !== 'object' || data === null) {
      throw new Error('Invalid data: data should be a non-null object');
    }

    const result = model.reduce((acc, { path, alias }) => {
      const key = alias ?? path.replace(/\./g, '_');
      const value = _.get(data, path);
      acc[key] = value;

      return acc;
    }, {});

    return result;
  }

  async resume(node, prevJob, processor: Processor) {
    const { model } = node.config;

    // 处理数据输出：对结果进行字段映射（异步工作流场景）
    let result = prevJob.result;
    if (typeof result === 'object' && result && model?.length) {
      if (Array.isArray(result)) {
        result = result.map((item) => this.mapModel(item, model));
      } else {
        result = this.mapModel(result, model);
      }
    }
    // 保持向后兼容：即使没有 model 映射，也调用 set 方法
    prevJob.set('result', result);

    prevJob.set('status', prevJob.status);
    return prevJob;
  }
}
