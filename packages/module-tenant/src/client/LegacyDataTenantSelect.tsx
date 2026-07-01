import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@tachybase/client';
import { Field, observer, useField } from '@tachybase/schema';

import { Select } from 'antd';

type LegacyDataTenantOption = {
  label: string;
  value: string;
};

export async function loadLegacyDataTenantOptions(
  api: any,
  isCanceled: () => boolean,
  pageSize = 200,
): Promise<LegacyDataTenantOption[]> {
  const options: LegacyDataTenantOption[] = [];
  let page = 1;

  while (!isCanceled()) {
    const res = await api.resource('tenants').list({ page, pageSize });
    const tenants = res?.data?.data || [];

    options.push(
      ...tenants.map((tenant: any) => ({
        label: tenant.title || tenant.name || tenant.id,
        value: tenant.id,
      })),
    );

    if (tenants.length < pageSize) {
      break;
    }

    page += 1;
  }

  return options;
}

export const LegacyDataTenantSelect = observer(
  (props: any) => {
    const api = useAPIClient();
    const field = useField<Field>();
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
          }
        });

      return () => {
        canceled = true;
      };
    }, [api]);

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
