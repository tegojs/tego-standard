import { Plugin } from '@tachybase/client';

import { EditableSchemaSettingsProvider } from './contexts/EditableSchemaSettingsContext';
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
  private editableSchemaSettingsManager: EditableSchemaSettingsManager;

  async afterAdd() {
    // 初始化 EditableSchemaSettingsManager
    this.editableSchemaSettingsManager = new EditableSchemaSettingsManager([], this.app);
  }

  async beforeLoad() {}

  async load() {
    // 添加 EditableSchemaSettingsProvider 到应用提供者中
    this.app.addProvider(EditableSchemaSettingsProvider, {
      editableSchemaSettingsManager: this.editableSchemaSettingsManager,
    });
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

    this.editableSchemaSettingsManager.add(formItemFieldEditableSettings);
    this.editableSchemaSettingsManager.add(createFormBlockEditableSettings);
    this.editableSchemaSettingsManager.add(fieldInterfaceEditableSettings);

    // editable field component settings
    this.editableSchemaSettingsManager.add(selectComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(checkboxComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(datePickerComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(unixTimestampComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(uploadAttachmentComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(inputNumberComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(recordPickerComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(radioComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(subTablePopoverComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(subformComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(subformPopoverComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(drawerSubTableComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(cascaderComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(CustomTitleComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(fileManagerComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(tagComponentFieldEditableSettings);
    this.editableSchemaSettingsManager.add(cascadeSelectComponentFieldEditableSettings);

    // register icons
    await import('./icons');
  }

  // 提供获取 EditableSchemaSettingsManager 的方法
  getEditableSchemaSettingsManager() {
    return this.editableSchemaSettingsManager;
  }
}

export default PluginFormDesignClient;
