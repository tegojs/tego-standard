import React, { createContext, useContext } from 'react';

import { EditableSchemaSettingsManager } from '../editable-schema-settings';

interface EditableSchemaSettingsContextType {
  editableSchemaSettingsManager: EditableSchemaSettingsManager;
}

const EditableSchemaSettingsContext = createContext<EditableSchemaSettingsContextType | null>(null);

export const EditableSchemaSettingsProvider: React.FC<{
  children: React.ReactNode;
  editableSchemaSettingsManager: EditableSchemaSettingsManager;
}> = ({ children, editableSchemaSettingsManager }) => {
  return (
    <EditableSchemaSettingsContext.Provider value={{ editableSchemaSettingsManager }}>
      {children}
    </EditableSchemaSettingsContext.Provider>
  );
};

export const useEditableSchemaSettingsManager = () => {
  const context = useContext(EditableSchemaSettingsContext);
  if (!context) {
    throw new Error('useEditableSchemaSettingsManager must be used within EditableSchemaSettingsProvider');
  }
  return context.editableSchemaSettingsManager;
};
