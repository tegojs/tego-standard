import { useMemo } from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { useComponent } from './useComponent';
import { useDesignable } from './useDesignable';

const Def = () => null;

export const useDesigner = () => {
  const { designable } = useDesignable();
  const fieldSchema = useFieldSchema();

  const toolbar = useMemo(() => {
    if (fieldSchema['x-designer'] || fieldSchema['x-toolbar'])
      return fieldSchema['x-designer'] || fieldSchema['x-toolbar'];

    if (fieldSchema['x-settings']) {
      return require('../../schema-settings').SchemaToolbar;
    }
    return Def;
  }, [fieldSchema]);

  const component = useComponent(toolbar);
  return designable ? component || Def : Def;
};
