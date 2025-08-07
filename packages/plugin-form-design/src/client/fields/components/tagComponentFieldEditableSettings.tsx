import {
  isSubMode,
  useCollectionField,
  useColorFields,
  useColumnSchema,
  useFieldComponentName,
  useFieldModeOptions,
  useIsAddNewForm,
  useTitleFieldOptions,
} from '@tachybase/client';
import { Field, useField, useFieldSchema } from '@tachybase/schema';

import { EditableSchemaSettings } from '../../editable-schema-settings/EditableSchemaSettings';
import { useTranslation } from '../../locale';

export const tagComponentFieldEditableSettings = new EditableSchemaSettings({
  name: 'editableFieldSettings:component:Tag',
  items: [
    {
      name: 'fieldComponent',
      useSchema() {
        const { t } = useTranslation();
        const field = useField<Field>();
        const isAddNewForm = useIsAddNewForm();
        const { fieldSchema: tableColumnSchema, collectionField } = useColumnSchema();
        const fieldModeOptions = useFieldModeOptions({ fieldSchema: tableColumnSchema, collectionField });
        const schema = useFieldSchema();
        const fieldSchema = tableColumnSchema || schema;
        const fieldComponentName = useFieldComponentName();
        return {
          type: 'string',
          title: '{{t("Field component")}}',
          default: fieldComponentName,
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          'x-component-props': {
            allowClear: false,
            showSearch: false,
            options: fieldModeOptions,
            onChange: (mode) => {
              const schema = {
                ['x-uid']: fieldSchema['x-uid'],
              };
              fieldSchema['x-component-props'] = fieldSchema['x-component-props'] || {};
              fieldSchema['x-component-props']['mode'] = mode;
              schema['x-component-props'] = fieldSchema['x-component-props'];
              field.componentProps = field.componentProps || {};
              field.componentProps.mode = mode;

              // 子表单状态不允许设置默认值
              if (isSubMode(fieldSchema) && isAddNewForm) {
                // @ts-ignore
                schema.default = null;
                fieldSchema.default = null;
                field.setInitialValue(null);
                field.setValue(null);
              }
            },
          },
        };
      },
    },
    {
      name: 'tagColorField',
      useSchema() {
        const { t } = useTranslation();
        const field = useField<Field>();
        const schema = useFieldSchema();
        const targetCollectionField = useCollectionField();
        const { fieldSchema: tableColumnSchema, collectionField: tableColumnField } = useColumnSchema();
        const fieldSchema = tableColumnSchema || schema;
        const collectionField = tableColumnField || targetCollectionField;
        const colorFieldOptions = useColorFields(collectionField?.target ?? collectionField?.targetCollection);
        return {
          type: 'string',
          title: '{{t("Tag color field")}}',
          default: field?.componentProps?.tagColorField,
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          'x-component-props': {
            allowClear: false,
            showSearch: false,
            options: colorFieldOptions,
            onChange(tagColorField) {
              const schema = {
                ['x-uid']: fieldSchema['x-uid'],
              };

              fieldSchema['x-component-props'] = fieldSchema['x-component-props'] || {};
              fieldSchema['x-component-props']['tagColorField'] = tagColorField;
              schema['x-component-props'] = fieldSchema['x-component-props'];
              field.componentProps.tagColorField = tagColorField;
            },
          },
        };
      },
    },
    {
      name: 'titleField',
      useSchema() {
        const { t } = useTranslation();
        const field = useField<Field>();
        const { fieldSchema: tableColumnSchema, collectionField: tableColumnField } = useColumnSchema();
        const schema = useFieldSchema();
        const fieldSchema = tableColumnSchema || schema;
        const options = useTitleFieldOptions();
        const targetCollectionField = useCollectionField();
        const collectionField = tableColumnField || targetCollectionField;
        return {
          type: 'string',
          title: '{{t("Title field")}}',
          default: field?.componentProps?.fieldNames?.label,
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          'x-component-props': {
            allowClear: false,
            showSearch: false,
            options,
            onChange(label) {
              const schema = {
                ['x-uid']: fieldSchema['x-uid'],
              };
              const fieldNames = {
                ...collectionField?.uiSchema?.['x-component-props']?.['fieldNames'],
                ...field.componentProps.fieldNames,
                label,
              };
              fieldSchema['x-component-props'] = fieldSchema['x-component-props'] || {};
              fieldSchema['x-component-props']['fieldNames'] = fieldNames;
              schema['x-component-props'] = fieldSchema['x-component-props'];
              field.componentProps.fieldNames = fieldSchema['x-component-props'].fieldNames;
            },
          },
        };
      },
    },
    {
      name: 'enableLink',
      useVisible() {
        const field = useField();
        return field.readPretty;
      },
      useSchema() {
        const { t } = useTranslation();
        const field = useField<Field>();
        const fieldSchema = useFieldSchema();
        return {
          type: 'boolean',
          default: fieldSchema['x-component-props']?.enableLink !== false,
          'x-decorator': 'FormItem',
          'x-component': 'Checkbox',
          'x-content': '{{t("Enable link")}}',
          'x-component-props': {
            onInput: (e) => {
              const flag = e?.target?.checked ?? false;
              fieldSchema['x-component-props'] = {
                ...fieldSchema?.['x-component-props'],
                enableLink: flag,
              };
              field.componentProps['enableLink'] = flag;
            },
          },
        };
      },
    },
  ],
});
