import { SchemaComponent, useRecord } from '@tachybase/client';

import { CheckContentContainer } from './CheckContentContainer';
import { getSchemaActionTodos, getSchemaCreateActionLaunch } from './CheckLink.schema';

// 审批-待办: 操作-快速发起
export const CreateCheckLink = (props) => {
  const { popoverComponent = 'Action.Modal', popoverComponentProps = {} } = props;
  const record = useRecord();

  const schema = getSchemaCreateActionLaunch({
    record,
    popoverComponent,
    popoverComponentProps,
  });

  return <SchemaComponent schema={schema} />;
};
