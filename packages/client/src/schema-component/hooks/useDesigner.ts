import React, { useMemo } from 'react';
import { useFieldSchema } from '@tachybase/schema';

import { useComponent } from './useComponent';
import { useDesignable } from './useDesignable';

const Def = () => null;
const LazySchemaToolbar = React.lazy(() =>
  import('../../schema-settings/GeneralSchemaDesigner').then((module) => ({ default: module.SchemaToolbar })),
);

const SchemaToolbar = (props) =>
  React.createElement(React.Suspense, { fallback: null }, React.createElement(LazySchemaToolbar, props));

export const useDesigner = () => {
  const { designable } = useDesignable();
  const fieldSchema = useFieldSchema();

  const toolbar = useMemo(() => {
    if (fieldSchema['x-designer'] || fieldSchema['x-toolbar'])
      return fieldSchema['x-designer'] || fieldSchema['x-toolbar'];

    if (fieldSchema['x-settings']) {
      return SchemaToolbar;
    }
    return Def;
  }, [fieldSchema]);

  const component = useComponent(toolbar);
  return designable ? component || Def : Def;
};
