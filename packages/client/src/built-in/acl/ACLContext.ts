import { createContext, useContext } from 'react';
import { Schema } from '@tachybase/schema';

export const ACLContext = createContext<any>({});
ACLContext.displayName = 'ACLContext';

export const useACLContext = () => {
  return useContext(ACLContext);
};

export const ACLActionParamsContext = createContext<any>({});
ACLActionParamsContext.displayName = 'ACLActionParamsContext';

export const useACLActionParamsContext = () => {
  return useContext(ACLActionParamsContext);
};

export const useACLFieldWhitelist = () => {
  const params = useContext(ACLActionParamsContext);
  const whitelist = []
    .concat(params?.whitelist || [])
    .concat(params?.fields || [])
    .concat(params?.appends || []);
  return {
    whitelist,
    schemaInWhitelist(fieldSchema: Schema, isSkip?) {
      if (isSkip) {
        return true;
      }
      if (whitelist.length === 0) {
        return true;
      }
      if (!fieldSchema) {
        return true;
      }
      if (!fieldSchema['x-collection-field']) {
        return true;
      }
      const [key1, key2] = fieldSchema['x-collection-field'].split('.');
      return whitelist?.includes(key2 || key1);
    },
  };
};
