import { ProviderContextWorkflow } from '@tachybase/module-workflow/client';

import { ApprovalContext, ResubmitProvider } from '../../../../common';
import { ProviderContextApprovalExecution } from '../../../../common/contexts/approvalExecution';

export const ProviderCheckContent = (props) => {
  const { params, children } = props;
  const { workflow, approval, execution, approvalValue } = params;

  return (
    <ProviderContextWorkflow
      value={{
        workflow: workflow,
        nodes: approval?.nodes,
        execution: execution,
      }}
    >
      <ApprovalContext.Provider value={approval}>
        <ProviderContextApprovalExecution value={approvalValue}>
          <ResubmitProvider>{children}</ResubmitProvider>
        </ProviderContextApprovalExecution>
      </ApprovalContext.Provider>
    </ProviderContextWorkflow>
  );
};
