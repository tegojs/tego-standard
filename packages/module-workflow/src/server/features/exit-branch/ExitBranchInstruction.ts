import { JOB_STATUS } from '../../constants';
import Instruction from '../../instructions';

export class ExitBranchInstruction extends Instruction {
  async run(node, prevJob, processor) {
    const job = await processor.saveJob({
      result: prevJob?.result ?? null,
      status: JOB_STATUS.RESOLVED,
      upstreamId: prevJob?.id ?? null,
      nodeId: node.id,
      nodeKey: node.key,
    });

    await processor.end(node, job);

    return null;
  }
}
