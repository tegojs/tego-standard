import Jobs from '../../collections/2-jobs';
import { JOB_STATUS } from '../../constants';
import Instruction from '../../instructions';
import Processor from '../../Processor';

export class TriggerInstruction extends Instruction {
  async run(node, input, processor: Processor) {
    const workflowKey = node.config.workflowKey;
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
      if (wf.sync) {
        const p = await this.workflow.trigger(wf, input.result, processor.options);
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

        return {
          status: JOB_STATUS.RESOLVED,
          result: lastSavedJob?.result,
        };
      } else {
        this.workflow.trigger(wf, input.result, {
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

  async resume(node, prevJob, processor: Processor) {
    prevJob.set('result', prevJob.result);
    prevJob.set('status', prevJob.status);
    return prevJob;
  }
}
