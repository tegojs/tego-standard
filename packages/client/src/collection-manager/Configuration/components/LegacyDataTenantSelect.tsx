import React, { useEffect, useState } from 'react';
import { Field, observer, useField } from '@tachybase/schema';

import { Select } from 'antd';

import { useAPIClient } from '../../../api-client';

export const LegacyDataTenantSelect = observer(
  (props: any) => {
    const api = useAPIClient();
    const field = useField<Field>();
    const [options, setOptions] = useState([]);

    useEffect(() => {
      let canceled = false;

      api
        .resource('tenants')
        .list({ pageSize: 200 })
        .then((res) => {
          if (canceled) {
            return;
          }

          const tenants = res?.data?.data || [];
          setOptions(
            tenants.map((tenant: any) => ({
              label: tenant.title || tenant.name || tenant.id,
              value: tenant.id,
            })),
          );
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
