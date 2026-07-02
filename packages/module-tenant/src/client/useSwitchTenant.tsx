import React, { useMemo, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

import { message, Select } from 'antd';

import { CURRENT_TENANT_ID_STORAGE_KEY, TENANT_MENU_KEY } from './constants';
import { useCurrentTenantContext } from './CurrentTenantProvider';
import { lang } from './locale';

export const useSwitchTenant = () => {
  const api = useAPIClient();
  const { data } = useCurrentTenantContext() || {};
  const [switching, setSwitching] = useState(false);

  return useMemo<React.ReactElement | null>(() => {
    const tenants = (data?.data || []).filter((item) => item.enabled !== false);
    if (tenants.length <= 1) {
      return null;
    }

    const currentTenant = tenants.find((item) => item.current);

    return (
      <div key={TENANT_MENU_KEY} className="tenant-nav-switcher">
        <Select
          fieldNames={{
            label: 'title',
            value: 'id',
          }}
          options={tenants.map((item) => ({
            ...item,
            title: item.title || item.name || item.id,
          }))}
          value={currentTenant?.id}
          disabled={switching}
          loading={switching}
          popupMatchSelectWidth={false}
          variant="borderless"
          style={{ minWidth: 'auto', width: 'auto' }}
          onChange={async (tenantId) => {
            if (switching) {
              return;
            }

            setSwitching(true);
            try {
              await api.resource('tenants').switch({ values: { tenantId } });
              api.storage?.setItem?.(CURRENT_TENANT_ID_STORAGE_KEY, tenantId as string);
              window.location.reload();
            } catch (error: any) {
              const errorMessage =
                error?.response?.data?.errors?.[0]?.message || error?.message || lang('Failed to switch tenant');
              message.error(errorMessage);
            } finally {
              setSwitching(false);
            }
          }}
        />
      </div>
    );
  }, [api, data?.data, switching]);
};

export default useSwitchTenant;
