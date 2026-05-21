import React, { useMemo } from 'react';
import { useAPIClient } from '@tachybase/client';

import { Select } from 'antd';

import { useCurrentTenantContext } from './CurrentTenantProvider';

export const useSwitchTenant = () => {
  const api = useAPIClient();
  const { data } = useCurrentTenantContext() || {};

  return useMemo<React.ReactElement | null>(() => {
    const tenants = (data?.data || []).filter((item) => item.enabled !== false);
    if (tenants.length <= 1) {
      return null;
    }

    const currentTenant = tenants.find((item) => item.current);

    return (
      <div key="tenant" className="tenant-nav-switcher">
        <Select
          fieldNames={{
            label: 'title',
            value: 'id',
          }}
          options={tenants.map((item) => ({
            ...item,
            title: item.title || item.name || item.id,
          }))}
          defaultValue={currentTenant?.id}
          popupMatchSelectWidth={false}
          variant="borderless"
          style={{ minWidth: 'auto', width: 'auto' }}
          onChange={async (tenantId) => {
            await api.resource('tenants').switch({ values: { tenantId } });
            api.storage?.setItem?.('current_tenant_id', tenantId as string);
            window.location.reload();
          }}
        />
      </div>
    );
  }, [api, data?.data]);
};

export default useSwitchTenant;
