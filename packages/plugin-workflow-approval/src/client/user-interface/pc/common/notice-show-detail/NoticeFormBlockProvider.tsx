import { useMemo } from 'react';
import { FormBlockProvider } from '@tachybase/client';
import { DetailsBlockProvider, FlowContext, useFlowContext } from '@tachybase/module-workflow/client';

import { resolveNoticeSnapshot } from '../../../../common/tools/notice-snapshot';
import { useContexWorkflowNotice } from './contexts/WorkflowNotice.context';

export function NoticeFormBlockProvider(props) {
  const { collectionName, snapshot } = useContexWorkflowNotice();
  const flowContext = useFlowContext();
  const noticeFlowContext = useMemo(
    () => ({
      ...flowContext,
      execution: {
        ...flowContext.execution,
        context: {
          ...flowContext.execution?.context,
          data: resolveNoticeSnapshot({ snapshot, collectionName }, flowContext.execution?.context),
        },
      },
    }),
    [flowContext, snapshot, collectionName],
  );
  if (props.collection === collectionName && (!props.dataSource || props.dataSource === 'main')) {
    return (
      <FlowContext.Provider value={noticeFlowContext}>
        <DetailsBlockProvider collection={props.collection} dataPath={props.dataPath ?? '$context.data'}>
          {props.children}
        </DetailsBlockProvider>
      </FlowContext.Provider>
    );
  }

  return <FormBlockProvider {...props} />;
}
