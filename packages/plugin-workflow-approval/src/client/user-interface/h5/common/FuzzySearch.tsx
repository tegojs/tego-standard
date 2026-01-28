import { mergeFilter } from '@tachybase/client';

import { getFuzzyFilter } from '../../common/FuzzyFilter';

export const fuzzySearch = ({ filter, params, input, isInitiationTable }) => {
  if (input === '') {
    return { ...params, ...filter };
  }
  const fuzzyFilter = getFuzzyFilter(input, isInitiationTable);
  const mergedFilter = mergeFilter([filter, params, fuzzyFilter]);
  return mergedFilter;
};
