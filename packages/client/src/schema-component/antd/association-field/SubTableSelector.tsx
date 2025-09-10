import React from 'react';
import { RecursionField } from '@tachybase/schema';

import { ActionContextProvider, FormProvider, RecordPickerProvider, SchemaComponentOptions } from '../..';
import { TableSelectorParamsProvider } from '../../../block-provider/TableSelectorProvider';
import { CollectionProvider_deprecated } from '../../../collection-manager';
import { useTableSelectorProps } from './InternalPicker';

interface SelectorProps {
  field: any;
  fieldSchemaParent: any;
  collectionField: any;
  visible: boolean;
  setVisible: (v: boolean) => void;
  pickerProps: any;
  getFilter: () => any;
  usePickActionProps: () => any;
  openSize?: string;
}

const SubTableSelector: React.FC<SelectorProps> = ({
  field,
  fieldSchemaParent,
  collectionField,
  visible,
  setVisible,
  pickerProps,
  getFilter,
  usePickActionProps,
  openSize,
}) => {
  if (!visible) return null;
  return (
    <ActionContextProvider
      value={{
        openSize,
        openMode: 'drawer',
        visible,
        setVisible,
      }}
    >
      <RecordPickerProvider {...pickerProps}>
        <CollectionProvider_deprecated name={collectionField?.target}>
          <FormProvider>
            <TableSelectorParamsProvider params={{ filter: getFilter() }}>
              <SchemaComponentOptions
                scope={{
                  usePickActionProps,
                  useTableSelectorProps,
                }}
              >
                <RecursionField
                  onlyRenderProperties
                  basePath={field.address}
                  schema={fieldSchemaParent}
                  filterProperties={(s) => s['x-component'] === 'AssociationField.Selector'}
                />
              </SchemaComponentOptions>
            </TableSelectorParamsProvider>
          </FormProvider>
        </CollectionProvider_deprecated>
      </RecordPickerProvider>
    </ActionContextProvider>
  );
};
export default SubTableSelector;
