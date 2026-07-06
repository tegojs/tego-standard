import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@tachybase/client';
import { Field, observer, useField } from '@tachybase/schema';

import { App, Select } from 'antd';

import { lang } from './locale';
import { loadTenantRecords } from './tenant-tree';

type LegacyDataTenantOption = {
  label: string;
  value: string;
};

export async function loadLegacyDataTenantOptions(
  api: any,
  isCanceled: () => boolean,
  pageSize = 200,
): Promise<LegacyDataTenantOption[]> {
  const tenants = await loadTenantRecords(api, isCanceled, pageSize);

  return tenants.map((tenant: any) => ({
    label: tenant.title || tenant.name || tenant.id,
    value: tenant.id,
  }));
}

export const LegacyDataTenantSelect = observer(
  (props: any) => {
    const api = useAPIClient();
    const field = useField<Field>();
    const { message } = App.useApp();
    const [options, setOptions] = useState([]);

    useEffect(() => {
      let canceled = false;

      loadLegacyDataTenantOptions(api, () => canceled)
        .then((nextOptions) => {
          if (canceled) {
            return;
          }

          setOptions(nextOptions);
        })
        .catch(() => {
          if (!canceled) {
            setOptions([]);
            message.error(lang('Failed to load tenants'));
          }
        });

      return () => {
        canceled = true;
      };
    }, [api, message]);

    return (
      <Select
        {...props}
        allowClear
        disabled={field.disabled || props.disabled}
        mode="multiple"
        options={options}
        showSearch
      />
    );
  },
  { displayName: 'LegacyDataTenantSelect' },
);
