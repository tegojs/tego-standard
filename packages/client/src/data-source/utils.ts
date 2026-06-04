import { useMemo } from 'react';

import _ from 'lodash';

import type { CollectionFieldOptions } from './collection/Collection';
import type { DataSourceManager } from './data-source/DataSourceManager';

const DEFAULT_DATA_SOURCE_KEY = 'main';

export const isTitleField = (dm: DataSourceManager, field: CollectionFieldOptions) => {
  return !field.isForeignKey && dm.collectionFieldInterfaceManager.getFieldInterface(field.interface)?.titleUsable;
};

export const useDataSourceHeaders = (dataSource?: string): any => {
  const headers = useMemo(() => {
    if (dataSource && dataSource !== DEFAULT_DATA_SOURCE_KEY) {
      return { 'x-data-source': dataSource };
    }
  }, [dataSource]);

  return headers;
};
