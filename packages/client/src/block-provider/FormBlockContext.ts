import { createContext, useContext } from 'react';

import type { CollectionRecord } from '../data-source';

export const FormBlockContext = createContext<{
  form?: any;
  type?: 'update' | 'create';
  action?: string;
  field?: any;
  service?: any;
  resource?: any;
  updateAssociationValues?: any;
  formBlockRef?: any;
  collectionName?: string;
  params?: any;
  formRecord?: CollectionRecord;
  [key: string]: any;
}>({});
FormBlockContext.displayName = 'FormBlockContext';

/**
 * @internal
 */
export const useFormBlockContext = () => {
  return useContext(FormBlockContext);
};
