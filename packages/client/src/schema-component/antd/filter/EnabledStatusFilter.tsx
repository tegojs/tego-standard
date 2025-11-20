import React, { useCallback, useEffect, useState } from 'react';
import { mergeFilter, useDataBlockProps, useDataBlockRequest, useTranslation } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { Radio } from 'antd';

export const EnabledStatusFilter = observer(() => {
  const { t } = useTranslation();
  const service = useDataBlockRequest();
  const blockProps = useDataBlockProps();
  const [status, setStatus] = useState<string>('all');

  // 从 URL 参数或默认 filter 中获取初始状态
  useEffect(() => {
    const params = service?.params?.[0] || {};
    const filter = params.filter || {};

    // 检查 storedFilter 中是否有 statusFilter
    const storedFilter = service?.params?.[1]?.filters || {};
    const statusFilter = storedFilter['statusFilter'];

    if (statusFilter?.enabled === true) {
      setStatus('enabled');
    } else if (statusFilter?.enabled === false) {
      setStatus('disabled');
    } else if (filter.enabled === true) {
      setStatus('enabled');
    } else if (filter.enabled === false) {
      setStatus('disabled');
    } else {
      setStatus('all');
    }
  }, [service?.params]);

  const handleChange = useCallback(
    (e: any) => {
      const newStatus = e.target.value;
      setStatus(newStatus);

      const storedFilter = service?.params?.[1]?.filters || {};
      const defaultFilter = blockProps?.params?.filter || {};

      // 根据选择的状态更新 filter
      if (newStatus === 'all') {
        delete storedFilter['statusFilter'];
      } else {
        storedFilter['statusFilter'] = {
          enabled: newStatus === 'enabled',
        };
      }

      // 合并所有 filter
      const mergedFilter = mergeFilter([...Object.values(storedFilter), defaultFilter]);

      // 更新 service
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
    [service, blockProps],
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
