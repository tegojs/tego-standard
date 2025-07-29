import { useCallback, useState } from 'react';
import {
  Collection,
  CollectionFieldOptions,
  createCreateFormBlockUISchema,
  useAssociationName,
  useCreateFormBlock,
  useSchemaInitializerItem,
} from '@tachybase/client';
import { ISchema, Schema, uid } from '@tachybase/schema';

import { FormOutlined } from '@ant-design/icons';

import {
  createCreateFormEditUISchema,
  EditableSelectedFieldProvider,
  FormSchemaEditor,
} from './components/form-editor';
import { EditableSelectedFormProvider } from './components/form-editor/EditableSelectedFormContent';
import { EditableDataBlockInitializer } from './EditableDataBlockInitializer';

export const EditableFormBlockInitializer = ({
  filterCollections,
  onlyCurrentDataSource,
  hideSearch,
  createBlockSchema,
  componentType = 'FormItem',
  templateWrap: customizeTemplateWrap,
  showAssociationFields,
  hideChildrenIfSingleCollection,
  hideOtherRecordsInPopup,
  currentText,
  otherText,
}: {
  filterCollections: (options: { collection?: Collection; associationField?: CollectionFieldOptions }) => boolean;
  onlyCurrentDataSource: boolean;
  hideSearch?: boolean;
  createBlockSchema?: (options: any) => any;
  /**
   * 虽然这里的命名现在看起来比较奇怪，但为了兼容旧版本的 template，暂时保留这个命名。
   */
  componentType?: 'FormItem';
  templateWrap?: (
    templateSchema: any,
    {
      item,
    }: {
      item: any;
    },
  ) => any;
  showAssociationFields?: boolean;
  hideChildrenIfSingleCollection?: boolean;
  /**
   * 隐藏弹窗中的 Other records 选项
   */
  hideOtherRecordsInPopup?: boolean;
  /** 用于更改 Current record 的文案 */
  currentText?: string;
  /** 用于更改 Other records 的文案 */
  otherText?: string;
}) => {
  const [visible, setVisible] = useState(false);
  const [pendingOptions, setPendingOptions] = useState<any>(null);
  const schemaUID = pendingOptions?.schema['x-uid'] || null;
  const itemConfig = useSchemaInitializerItem();
  const { templateWrap, createEditFormBlock } = useCreateEditableFormBlock();
  const onCreateFormBlockSchema = useCallback((options) => {
    if (createBlockSchema) {
      return createBlockSchema(options);
    }
    const schema = new Schema(createEditFormBlock(options));
    setPendingOptions({ schema, ...options });
    setVisible(true);
  }, []);

  const handleClose = () => {
    setVisible(false);
    setPendingOptions(null);
  };

  return (
    <>
      <EditableDataBlockInitializer
        {...itemConfig}
        icon={<FormOutlined />}
        componentType={componentType}
        templateWrap={(templateSchema, options) => {
          if (customizeTemplateWrap) {
            return customizeTemplateWrap(templateSchema, options);
          }

          return templateWrap(templateSchema, options);
        }}
        onCreateBlockSchema={onCreateFormBlockSchema}
        filter={filterCollections}
        onlyCurrentDataSource={onlyCurrentDataSource}
        hideSearch={hideSearch}
        showAssociationFields={showAssociationFields}
        hideChildrenIfSingleCollection={hideChildrenIfSingleCollection}
        hideOtherRecordsInPopup={hideOtherRecordsInPopup}
        currentText={currentText}
        otherText={otherText}
      />
      <EditableSelectedFormProvider>
        <EditableSelectedFieldProvider>
          <FormSchemaEditor key={schemaUID} open={visible} onCancel={handleClose} options={pendingOptions} />
        </EditableSelectedFieldProvider>
      </EditableSelectedFormProvider>
    </>
  );
};

export const useCreateEditableFormBlock = () => {
  const association = useAssociationName();
  const { isCusomeizeCreate: isCustomizeCreate } = useSchemaInitializerItem();

  const templateWrap = (templateSchema, { item }) => {
    const schema = createCreateFormBlockUISchema({
      isCusomeizeCreate: isCustomizeCreate,
      dataSource: item.dataSource,
      templateSchema: templateSchema,
      collectionName: item.name,
      association,
    });
    if (item.template && item.mode === 'reference') {
      schema['x-template-key'] = item.template.key;
    }
    return schema;
  };

  const createEditFormBlock = ({ item, fromOthersInPopup }) => {
    const schema = fromOthersInPopup
      ? createCreateFormEditUISchema({
          collectionName: item.collectionName || item.name,
          dataSource: item.dataSource,
          isCusomeizeCreate: true,
        })
      : createCreateFormEditUISchema(
          association
            ? {
                association,
                dataSource: item.dataSource,
                isCusomeizeCreate: isCustomizeCreate,
              }
            : {
                collectionName: item.collectionName || item.name,
                dataSource: item.dataSource,
                isCusomeizeCreate: isCustomizeCreate,
              },
        );
    return gridRowColWrap(schema);
  };

  return {
    templateWrap,
    createEditFormBlock,
  };
};

const gridRowColWrap = (schema: ISchema) => {
  return {
    type: 'void',
    'x-component': 'Grid.Row',
    properties: {
      [uid()]: {
        type: 'void',
        'x-component': 'Grid.Col',
        properties: {
          [schema.name || uid()]: schema,
        },
      },
    },
  };
};
