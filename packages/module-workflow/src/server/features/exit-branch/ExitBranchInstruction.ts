import { JOB_STATUS } from '../../constants';
import Instruction from '../../instructions';

export class ExitBranchInstruction extends Instruction {
  async run(node, prevJob, processor) {
    return {
      result: prevJob?.result ?? null,
      status: JOB_STATUS.RESOLVED,
    };
  }
}
