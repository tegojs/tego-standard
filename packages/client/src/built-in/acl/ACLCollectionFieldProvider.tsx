import React, { useEffect } from 'react';
import { Field, useField, useFieldSchema } from '@tachybase/schema';

import { useACLFieldWhitelist } from './ACLContext';
import { useACLRoleContext } from './ACLProvider';

export const ACLCollectionFieldProvider = (props) => {
  const fieldSchema = useFieldSchema();
  const field = useField<Field>();
  const { allowAll } = useACLRoleContext();
  const { whitelist } = useACLFieldWhitelist();
  const [name] = (fieldSchema.name as string).split('.');
  const allowed = !fieldSchema['x-acl-ignore'] && whitelist.length > 0 ? whitelist.includes(name) : true;
  useEffect(() => {
    if (!allowed) {
      field.required = false;
      field.display = 'hidden';
    }
  }, [allowed]);

  if (allowAll) {
    return <>{props.children}</>;
  }

  if (!fieldSchema['x-collection-field']) {
    return <>{props.children}</>;
  }

  if (!allowed) {
    return null;
  }
  return <>{props.children}</>;
};
