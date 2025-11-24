import React, { useCallback, useEffect, useRef, useState } from 'react';
import { mergeFilter, useDataBlockProps, useDataBlockRequest } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { Radio } from 'antd';
import { useTranslation } from 'react-i18next';

const getCategoryId = (filter: any): string | number | undefined => {
  if (filter['category.id']) {
    return Array.isArray(filter['category.id']) ? filter['category.id'][0] : filter['category.id'];
  }
  if (filter.category?.id) {
    return Array.isArray(filter.category.id) ? filter.category.id[0] : filter.category.id;
  }
  if (filter.$and?.length) {
    for (const condition of filter.$and) {
      if (condition['category.id']) {
        return Array.isArray(condition['category.id']) ? condition['category.id'][0] : condition['category.id'];
      }
      if (condition.category?.id) {
        return Array.isArray(condition.category.id) ? condition.category.id[0] : condition.category.id;
      }
    }
  }
  return undefined;
};

export const EnabledStatusFilter = observer(() => {
  const { t } = useTranslation();
  const service = useDataBlockRequest();
  const blockProps = useDataBlockProps();
  const [status, setStatus] = useState<string>('all');
  const prevCategoryIdRef = useRef<string | number | undefined>(undefined);
  const isUserActionRef = useRef<boolean>(false);

  useEffect(() => {
    if (isUserActionRef.current) {
      isUserActionRef.current = false;
      return;
    }

    const params = service?.params?.[0] || {};
    const filter = params.filter || {};
    const defaultFilter = blockProps?.params?.filter || {};
    const currentCategoryId = getCategoryId(filter) || getCategoryId(defaultFilter);

    const categoryChanged =
      prevCategoryIdRef.current !== currentCategoryId &&
      (prevCategoryIdRef.current !== undefined || currentCategoryId !== undefined);

    if (categoryChanged) {
      prevCategoryIdRef.current = currentCategoryId;
      setStatus('all');

      const storedFilter = service?.params?.[1]?.filters || {};
      if (storedFilter['statusFilter']) {
        delete storedFilter['statusFilter'];
        const mergedFilter = mergeFilter([...Object.values(storedFilter), defaultFilter]);
        service.run(
          {
            ...service.params?.[0],
            page: 1,
            filter: mergedFilter,
          },
          {
            filters: storedFilter,
          },
        );
      }
      return;
    }

    prevCategoryIdRef.current = currentCategoryId;

    const storedFilter = service?.params?.[1]?.filters || {};
    const statusFilter = storedFilter['statusFilter'];
    const filterEnabled = filter.enabled;

    let newStatus = 'all';
    if (statusFilter?.enabled === true || filterEnabled === true) {
      newStatus = 'enabled';
    } else if (statusFilter?.enabled === false || filterEnabled === false) {
      newStatus = 'disabled';
    }

    if (newStatus !== status) {
      setStatus(newStatus);
    }
  }, [service?.params, blockProps]);

  const handleChange = useCallback(
    (e: any) => {
      const newStatus = e.target.value;
      if (newStatus === status) {
        return;
      }

      isUserActionRef.current = true;
      setStatus(newStatus);

      const storedFilter = { ...service?.params?.[1]?.filters };
      const defaultFilter = blockProps?.params?.filter || {};

      if (newStatus === 'all') {
        delete storedFilter['statusFilter'];
      } else {
        storedFilter['statusFilter'] = {
          enabled: newStatus === 'enabled',
        };
      }

      const mergedFilter = mergeFilter([...Object.values(storedFilter), defaultFilter]);
      service.run(
        {
          ...service.params?.[0],
          page: 1,
          filter: mergedFilter,
        },
        {
          filters: storedFilter,
        },
      );
    },
    [service, blockProps, status],
  );

  return (
    <Radio.Group
      value={status}
      onChange={handleChange}
      optionType="button"
      buttonStyle="solid"
      options={[
        { label: t('All statuses'), value: 'all' },
        { label: t('On'), value: 'enabled' },
        { label: t('Off'), value: 'disabled' },
      ]}
    />
  );
});
