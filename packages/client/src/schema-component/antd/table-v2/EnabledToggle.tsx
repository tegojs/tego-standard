import React from 'react';
import { useAPIClient, useCollectionRecordData, useDataBlockRequest, useTranslation } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { message, Switch } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ css }) => ({
  switchClass: css`
    &.ant-switch-checked {
      background-color: #52c41a !important;
    }
    min-height: 16px;
    height: 16px;
    line-height: 16px;
  `,
}));

export interface EnabledToggleProps {
  resource?: string;
  checkedChildren?: string;
  unCheckedChildren?: string;
  fieldName?: string;
  disabled?: boolean;
}

export const EnabledToggle = observer((props: EnabledToggleProps = {}) => {
  const { styles } = useStyles();
  const record = useCollectionRecordData();
  const api = useAPIClient();
  const { refresh } = useDataBlockRequest();
  const { t } = useTranslation();
  const fieldName = props.fieldName || 'enabled';
  const enabled = record?.[fieldName] ?? false;

  const resourceName = props.resource || 'workflows';
  const checkedChildren = props.checkedChildren || t('On');
  const unCheckedChildren = props.unCheckedChildren || t('Off');

  const handleChange = async (checked: boolean) => {
    if (props.disabled) {
      return;
    }
    try {
      await api.resource(resourceName).update({
        filterByTk: record.id,
        values: {
          enabled: checked,
        },
      });
      message.success(t('Operation succeeded'));
      refresh();
    } catch (error) {
      message.error(t('Operation failed'));
      console.error(error);
    }
  };

  return (
    <Switch
      checked={enabled}
      onChange={handleChange}
      checkedChildren={checkedChildren}
      unCheckedChildren={unCheckedChildren}
      size="small"
      className={styles.switchClass}
      disabled={props.disabled}
    />
  );
});
