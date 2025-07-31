import { Plugin } from '@tachybase/client';

import { EditableSchemaSettingsManager } from './editable-schema-settings';
import {
  cascaderComponentFieldEditableSettings,
  cascadeSelectComponentFieldEditableSettings,
  checkboxComponentFieldEditableSettings,
  CustomTitleComponentFieldEditableSettings,
  datePickerComponentFieldEditableSettings,
  drawerSubTableComponentFieldEditableSettings,
  fileManagerComponentFieldEditableSettings,
  inputNumberComponentFieldEditableSettings,
  radioComponentFieldEditableSettings,
  recordPickerComponentFieldEditableSettings,
  selectComponentFieldEditableSettings,
  subTablePopoverComponentFieldEditableSettings,
  tagComponentFieldEditableSettings,
  unixTimestampComponentFieldEditableSettings,
  uploadAttachmentComponentFieldEditableSettings,
} from './fields/components';
import { subformComponentFieldEditableSettings } from './fields/components/subformComponentFieldEditableSettings';
import { subformPopoverComponentFieldEditableSettings } from './fields/components/subformPopoverComponentFieldEditableSettings';
import { EditableFormItemSchemaToolbar, EditableFormToolbar } from './initializers/components/form-editor';
import { createFormBlockEditableSettings } from './initializers/components/form-editor/createFormBlockEditableSettings';
import { fieldInterfaceEditableSettings } from './initializers/components/form-editor/fieldsInterfaceEditableSettings';
import { formItemFieldEditableSettings } from './initializers/components/form-editor/formItemFieldEditableSettings';
import { SchemaSettingsEditablePage } from './initializers/components/schemaSetting/openFormEditablePage';
import { formDesignInitializerItem } from './initializers/formDesignInitializerItem';
import { FormDesignModalProvider } from './initializers/FormDesignModalProvider';

class PluginFormDesignClient extends Plugin {
  async afterAdd() {
    // 初始化 EditableSchemaSettingsManager
    this.app.editableSchemaSettingsManager = new EditableSchemaSettingsManager([], this.app);
  }

  async beforeLoad() {}

  async load() {
    this.app.addProvider(FormDesignModalProvider);
    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.formDesign', formDesignInitializerItem);
    this.app.addComponents({ SchemaSettingsEditablePage });
    this.app.schemaInitializerManager.addItem(
      'popup:common:addBlock',
      'otherBlocks.formDesign',
      formDesignInitializerItem,
    );
    // this.app.schemaInitializerManager.addItem(
    //   'popup:addNew:addBlock',
    //   'otherBlocks.formDesign',
    //   formDesignInitializerItem,
    // );
    this.app.addComponents({
      EditableFormToolbar,
      EditableFormItemSchemaToolbar,
    });

    this.app.editableSchemaSettingsManager.add(formItemFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(createFormBlockEditableSettings);
    this.app.editableSchemaSettingsManager.add(fieldInterfaceEditableSettings);

    // editable field component settings
    this.app.editableSchemaSettingsManager.add(selectComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(checkboxComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(datePickerComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(unixTimestampComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(uploadAttachmentComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(inputNumberComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(recordPickerComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(radioComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(subTablePopoverComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(subformComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(subformPopoverComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(drawerSubTableComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(cascaderComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(CustomTitleComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(fileManagerComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(tagComponentFieldEditableSettings);
    this.app.editableSchemaSettingsManager.add(cascadeSelectComponentFieldEditableSettings);
  }
}

export default PluginFormDesignClient;
