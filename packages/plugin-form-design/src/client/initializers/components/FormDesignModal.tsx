import { useState } from 'react';

import { EditableSelectedFieldProvider, FormSchemaEditor } from './form-editor';
import { EditableSelectedFormProvider } from './form-editor/EditableSelectedFormContent';

export const FormDesignModal = () => {
  const [visible, setVisible] = useState(false);
  const [pendingOptions, setPendingOptions] = useState<any>(null);
  const schemaUID = pendingOptions?.schema['x-uid'] || null;
  const handleClose = () => {
    setVisible(false);
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
