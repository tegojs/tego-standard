import { createContext, useContext } from 'react';
import type { GeneralField } from '@tachybase/schema';

/**
 * @deprecated
 */
export const BlockRequestContext_deprecated = createContext<{
  block?: string;
  props?: any;
  field?: GeneralField;
  service?: any;
  resource?: any;
  allowedActions?: any;
  __parent?: any;
  updateAssociationValues?: any[];
}>({});
BlockRequestContext_deprecated.displayName = 'BlockRequestContext_deprecated';

/**
 * @deprecated
 */
export const useBlockRequestContext = () => {
  return useContext(BlockRequestContext_deprecated);
};
