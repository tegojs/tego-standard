import { useApp } from '@tachybase/client';

export const useEditableSchemaSettingsManager = () => {
  const app = useApp();
  const formDesignPlugin = app.pm.get('@tachybase/plugin-form-design') as any;
  return formDesignPlugin?.getEditableSchemaSettingsManager();
};
