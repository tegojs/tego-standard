import { useActionContext, useAPIClient } from '@tachybase/client';
import { useField } from '@tachybase/schema';

import _ from 'lodash';

import { useApproval, useContextApprovalExecution } from '..';

export function useDestroyAction() {
  const field = useField();
  const { setSubmitted } = useActionContext() as any;
  const approval = useApproval();
  const apiClient = useAPIClient();

  return {
    async run() {
      try {
        _.set(field, ['data', 'loading'], true);

        await apiClient.resource('approvals').destroy({
          filterByTk: approval.id,
        });

        setSubmitted(true);
      } catch (err) {
        _.set(field, ['data', 'loading'], false);
      }
    },
  };
}
