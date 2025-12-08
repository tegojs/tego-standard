import React from 'react';
import { useActionContext, useGetAriaLabelOfAction, useRecord } from '@tachybase/client';

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const type = 'workflow-approval';

export function getWorkflowDetailPath(id: string | number) {
  return `/_admin/business-components/workflow-approval/${id}/workflow`;
}

export function getWorkflowExecutionsPath(id: string | number) {
  return `/_admin/business-components/workflow-approval/${id}/executions`;
}

export const WorkflowApprovalLink = () => {
  const { t } = useTranslation();
  const { id } = useRecord();
  const { setVisible } = useActionContext();
  const { getAriaLabel } = useGetAriaLabelOfAction('Configure');

  return (
    <Link aria-label={getAriaLabel()} to={getWorkflowDetailPath(id)} onClick={() => setVisible(false)}>
      {t('Configure')}
    </Link>
  );
};

export const ExecutionApprovalLink = () => {
  const { t } = useTranslation();
  const { id } = useRecord();
  const { setVisible } = useActionContext();
  return (
    <Link to={getWorkflowExecutionsPath(id)} onClick={() => setVisible(false)}>
      {t('View')}
    </Link>
  );
};
