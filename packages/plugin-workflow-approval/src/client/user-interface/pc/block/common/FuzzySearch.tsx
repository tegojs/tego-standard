import { mergeFilter, useDataBlockProps, useDataBlockRequest } from '@tachybase/client';

import { Input, Space } from 'antd';
import _ from 'lodash';

import { useTranslation } from '../../../../locale';
import { getFuzzyFilter } from '../../../common/FuzzyFilter';

export const FuzzySearch = (props) => {
  const { handleSearch, handleValueChange } = useProps(props);
  const { t } = useTranslation();
  return (
    <Space.Compact style={{ width: 300 }}>
      <Input.Search placeholder={t('Search Summary')} allowClear onSearch={handleSearch} onChange={handleValueChange} />
    </Space.Compact>
  );
};

function useProps(props) {
  const { isInitiationTable } = props;
  const service = useDataBlockRequest();

  const blockProps = useDataBlockProps();

  const handleSearch = (value) => {
    // 查询并更新数据
    searchActionSummary({
      isInitiationTable,
      queryValue: value.trim(),
      defaultFilter: blockProps?.params?.filter,
      service,
    });
  };

  const handleValueChange = _.debounce((event) => {
    const value = event.target?.value;
    if (!value) {
      searchActionSummary({
        isInitiationTable,
        queryValue: '',
        defaultFilter: blockProps?.params?.filter,
        service,
      });
    }
  });

  return {
    handleSearch,
    handleValueChange,
  };
}

/** 查询并更新数据 */
function searchActionSummary({
  isInitiationTable,
  // filter parameter for the filter action
  queryValue,
  // filter parameter for the block
  defaultFilter,
  service,
}) {
  const storedFilter = service.params?.[1]?.filters || {};

  // 自定义 jsonb 操作符: $containsJsonbValue, 在 server 有对应的实现
  // 构造查询参数
  const fuzzyFilter = getFuzzyFilter(queryValue, isInitiationTable);

  const mergedFilter = mergeFilter([...Object.values(storedFilter), defaultFilter, fuzzyFilter]);

  const params = {
    ...service.params?.[0],
    page: 1,
    filter: mergedFilter,
  };

  service.run(params, { filters: storedFilter });
}
