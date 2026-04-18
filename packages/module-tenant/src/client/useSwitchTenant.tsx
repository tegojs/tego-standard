import React, { useMemo } from 'react';

import { SelectWithTitle, useAPIClient } from '@tachybase/client';
import { MenuProps } from 'antd';

import { useCurrentTenantContext } from './CurrentTenantProvider';
import { useTenantTranslation } from './locale';

export const useSwitchTenant = () => {
  const api = useAPIClient();
  const { data } = useCurrentTenantContext() || {};
  const { t } = useTenantTranslation();

  return useMemo<MenuProps['items'][0]>(() => {
    const tenants = (data?.data || []).filter((item) => item.enabled !== false);
    if (tenants.length <= 1) {
      return null;
    }

    const currentTenant = tenants.find((item) => item.current);

    return {
      key: 'tenant',
      eventKey: 'SwitchTenant',
      label: (
        <SelectWithTitle
          title={t('Switch tenant')}
          fieldNames={{
            label: 'title',
            value: 'id',
          }}
          options={tenants.map((item) => ({
            ...item,
            title: item.title || item.name || item.id,
          }))}
          defaultValue={currentTenant?.id}
          onChange={async (tenantId) => {
            await api.resource('tenants').switch({ values: { tenantId } });
            window.location.reload();
          }}
        />
      ),
    };
  }, [api, data?.data, t]);
};

export default useSwitchTenant;
