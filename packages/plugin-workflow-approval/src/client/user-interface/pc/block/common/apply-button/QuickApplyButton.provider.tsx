import React from 'react';
import { ActionContextProvider, SchemaComponentContext, useActionContext } from '@tachybase/client';

import { DownOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';

import { useTranslation } from '../../../../../locale';

export const ProviderQuickApplyButton = (props) => {
  const { visible, setVisible, items, onClick, context, children } = props;
  const { t } = useTranslation();

  return (
    <ActionContextProvider value={{ visible, setVisible }}>
      <Button type="primary" onClick={onClick}>
        {t('Apply')}
      </Button>
      <SchemaComponentContext.Provider value={{ ...context, designable: false }}>
        {children}
      </SchemaComponentContext.Provider>
    </ActionContextProvider>
  );
};
