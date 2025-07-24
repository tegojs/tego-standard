import { useState } from 'react';

import { EditableSelectedFieldProvider, FormSchemaEditor } from './form-editor';
import { EditableSelectedFormProvider } from './form-editor/EditableSelectedFormContent';

export const FormDesignModal = ({ visible, onCancel }: { visible: boolean; onCancel: () => void }) => {
  const [pendingOptions, setPendingOptions] = useState<any>(null);
  const schemaUID = pendingOptions?.schema['x-uid'] || null;
  const handleClose = () => {
    onCancel?.();
    setPendingOptions(null);
  };
  return (
    <EditableSelectedFormProvider>
      <EditableSelectedFieldProvider>
        <FormSchemaEditor key={schemaUID} open={visible} onCancel={handleClose} options={pendingOptions} />
      </EditableSelectedFieldProvider>
    </EditableSelectedFormProvider>
  );
};
