import { Plugin } from '@tachybase/client';

import { NAMESPACE, tval } from '../../locale';
import { Instruction } from '../../nodes/default-node/interface';
import { PluginWorkflow } from '../../Plugin';

class ExitBranchInstruction extends Instruction {
  title = tval('Exit branch');
  type = 'exit-branch';
  group = 'control';
  icon = 'LogoutOutlined';
  color = '#52c41a';
  description = tval('Exit the current branch with success status and continue to the next node after the branch.');
  fieldset = {
    remarks: {
      type: 'string',
      title: `{{t("Remarks", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Input.TextArea',
      'x-component-props': {
        autoSize: {
          minRows: 3,
        },
        placeholder: `{{t("Input remarks", { ns: "${NAMESPACE}" })}}`,
      },
    },
  };

  // Only available in branches
  isAvailable(ctx) {
    return ctx && typeof ctx.branchIndex === 'number';
  }
}

export class PluginExitBranch extends Plugin {
  async load() {
    this.app.pm.get<PluginWorkflow>('workflow').registerInstruction('exit-branch', ExitBranchInstruction);
  }
}
